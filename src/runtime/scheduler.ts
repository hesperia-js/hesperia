import { afterPropagation, createObserver, type Observer } from "aeolia";
import type { Effect } from "../client.ts";
import { resumeBindings, suspendBindings } from "./binding.ts";
import { resumeFeeds, suspendFeeds } from "../data/feed.ts";
import { Owner, RenderFault, reportFault, runCleanup } from "./owner.ts";

interface Work {
  readonly owner: Owner;
  observer: Observer | undefined;
  readonly run: () => unknown;
  initial: boolean;
  active: boolean;
  cleanup: (() => void) | undefined;
  readonly structural: boolean;
}

/**
 * Document-tree scheduling over Aeolia's public observer API. Aeolia supplies
 * dependency facts; this scheduler owns only DOM/effect timing and tree order.
 */
export class Scheduler {
  private readonly root: Owner;
  private readonly works = new Map<Owner, Work[]>();
  private readonly renders = new Set<Work>();
  private readonly effects = new Map<Owner, Work[]>();
  private readonly pendingEffects = new Set<Work>();
  private readonly waiters: (() => void)[] = [];
  private readonly recreationCounts = new Map<string, number>();
  private readonly rawReplacementCounts = new Map<string, number>();
  private flushCount = 0;
  private reconciliationDepth = 0;
  private domScheduled = false;
  private effectScheduled = false;
  private flushingDom = false;
  private flushingEffects = false;

  /** Create a scheduler for a single explicit root lifetime. */
  constructor(root: Owner) {
    this.root = root;
  }

  /** Track a native write immediately, then repeat after synchronous Aeolia settlement. */
  render(owner: Owner, run: () => void, structural = false): void {
    const task = this.createWork(owner, run, structural);
    if (structural && owner.deferStructural && owner.state === "building") {
      this.renders.add(task);
      return;
    }
    task.observer!.track(run);
    task.initial = false;
  }

  /** Register a component effect without running its body before DOM commit. */
  effect(owner: Owner, run: Effect): void {
    const task = this.createWork(owner, run);
    const effects = this.effects.get(owner) ?? [];
    effects.push(task);
    this.effects.set(owner, effects);
    this.pendingEffects.add(task);
    owner.onCleanup(() => {
      const cleanup = task.cleanup;
      task.cleanup = undefined;
      cleanup?.();
    });
    this.requestEffects();
  }

  /** Schedule required-publication checks and pending effects after installed DOM. */
  requestEffects(): void {
    if (this.effectScheduled || this.flushingEffects || this.root.state !== "mounted") return;
    this.effectScheduled = true;
    queueMicrotask(() => {
      this.effectScheduled = false;
      this.flushEffects();
    });
  }

  /** Resolve at quiescence; useful to consumers that must inspect post-effect state. */
  settled(): Promise<void> {
    if (!this.hasPendingWork()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Hold native delivery until all validated input values have been published. */
  reconcile<T>(run: () => T): T {
    this.reconciliationDepth++;
    try {
      return run();
    } finally {
      this.reconciliationDepth--;
      if (!this.reconciliationDepth) this.flushDom();
    }
  }

  /** Flush detached structural work after a route host has installed its root range. */
  flush(): void {
    this.flushDom();
  }

  /** Pause one mounted owner subtree while retaining its state and native nodes. */
  suspend(root: Owner): void {
    if (root.state !== "mounted") return;
    const owners = this.subtree(root);
    for (const owner of owners) owner.state = "suspended";
    const errors: unknown[] = [];
    for (const owner of owners) {
      suspendBindings(owner);
      suspendFeeds(owner);
      for (const task of this.tasks(owner)) {
        this.renders.delete(task);
        this.pendingEffects.delete(task);
        task.observer?.dispose();
        task.observer = undefined;
        if (task.cleanup) {
          const cleanup = task.cleanup;
          task.cleanup = undefined;
          try {
            runCleanup(cleanup);
          } catch (error) {
            errors.push(error);
          }
        }
      }
    }
    if (errors.length) reportFault(root, new AggregateError(errors, "Component suspension failed"));
  }

  /** Resume one suspended owner subtree and refresh its latest DOM/effects. */
  resume(root: Owner): void {
    if (root.state !== "suspended") return;
    let ancestor = root.parent;
    while (ancestor) {
      if (ancestor.state !== "mounted")
        throw new RenderFault(
          "owner-state",
          "A suspended owner cannot resume beneath an inactive parent",
        );
      ancestor = ancestor.parent;
    }
    const owners = this.subtree(root);
    for (const owner of owners) owner.state = "mounted";
    for (const owner of owners) {
      resumeBindings(owner);
      resumeFeeds(owner);
      for (const task of this.tasks(owner)) {
        task.observer = this.makeObserver(task);
        if (task.owner.state !== "mounted") continue;
        if (this.renders.has(task)) this.renders.delete(task);
        if (this.effects.get(owner)?.includes(task)) {
          task.initial = true;
          this.pendingEffects.add(task);
        } else {
          try {
            task.observer.track(task.run);
            task.initial = false;
          } catch (error) {
            reportFault(task.owner, error);
          }
        }
      }
    }
    this.requestEffects();
  }

  /** Warn on repeated raw replacements without applying the component recreation limit. */
  requestRawReplacement(owner: Owner): void {
    const count = (this.rawReplacementCounts.get(owner.identity) ?? 0) + 1;
    this.rawReplacementCounts.set(owner.identity, count);
    if (count === 2)
      owner.context.warn(`Second raw HTML replacement of ${owner.identity} in one render frame`);
  }

  /** Apply the three-render rule to a logical identity across this entire connected frame. */
  requestRecreation(owner: Owner): void {
    const count = (this.recreationCounts.get(owner.identity) ?? 0) + 1;
    if (count >= 3)
      throw new RenderFault(
        "recreation-limit",
        `Third recreation of ${owner.identity} in one render frame`,
      );
    this.recreationCounts.set(owner.identity, count);
    if (count === 2)
      owner.context.warn(`Second recreation of ${owner.identity} in one render frame`);
  }

  private createWork(owner: Owner, run: () => unknown, structural = false): Work {
    owner.assertActive();
    const work: Work = {
      owner,
      run,
      observer: undefined,
      initial: true,
      active: true,
      cleanup: undefined,
      structural,
    };
    work.observer = this.makeObserver(work);
    const works = this.works.get(owner) ?? [];
    works.push(work);
    this.works.set(owner, works);
    owner.onRelease(() => {
      work.active = false;
      work.observer?.dispose();
      work.observer = undefined;
      this.renders.delete(work);
      this.pendingEffects.delete(work);
      this.effects.delete(owner);
      const remaining = this.works.get(owner);
      if (remaining) {
        const index = remaining.indexOf(work);
        if (index >= 0) remaining.splice(index, 1);
        if (remaining.length === 0) this.works.delete(owner);
      }
    });
    return work;
  }

  private permitRun(task: Work): boolean {
    if (
      !task.active ||
      task.observer === undefined ||
      task.owner.state === "suspended" ||
      task.owner.state === "cleaning" ||
      task.owner.state === "destroyed"
    )
      return false;
    return true;
  }

  private beginPass(): boolean {
    if (++this.flushCount <= 64) return true;
    for (const task of new Set([...this.renders, ...this.pendingEffects])) {
      task.active = false;
      task.observer?.dispose();
      task.observer = undefined;
    }
    this.renders.clear();
    this.pendingEffects.clear();
    reportFault(
      this.root,
      new RenderFault("render-cycle", "Reactive work exceeded 64 successive flushes"),
    );
    return false;
  }

  private flushDom(effectPassStart = false): void {
    if (this.flushingDom || this.reconciliationDepth) return;
    this.flushingDom = true;
    try {
      while (this.renders.size) {
        const batch = [...this.renders].filter(
          (task) => !this.flushingEffects || effectPassStart || !task.structural,
        );
        if (!batch.length) break;
        if (!this.flushingEffects && !this.beginPass()) break;
        for (const task of batch) this.renders.delete(task);
        for (const task of batch) {
          if (!this.permitRun(task)) continue;
          try {
            if (task.initial) {
              task.observer?.track(task.run);
              task.initial = false;
            } else if (task.observer?.check()) task.observer.track(task.run);
          } catch (error) {
            reportFault(task.owner, error);
          }
        }
      }
    } finally {
      this.flushingDom = false;
      this.finishIfSettled();
    }
  }

  private visit(owner: Owner, run: (owner: Owner) => void): void {
    for (const child of owner.children.slice()) this.visit(child, run);
    run(owner);
  }

  private flushEffects(): void {
    if (this.flushingEffects) return;
    this.flushingEffects = true;
    try {
      if (!this.beginPass()) return;
      this.flushDom(true);
      const ordered: Work[] = [];
      this.visit(this.root, (owner) => {
        if (!owner.isCommitted()) return;
        for (const task of this.effects.get(owner) ?? []) {
          if (this.pendingEffects.has(task)) ordered.push(task);
        }
      });
      for (const task of ordered) {
        if (!task.owner.isCommitted()) continue;
        this.pendingEffects.delete(task);
        if (!this.permitRun(task)) continue;
        try {
          if (!task.initial && !task.observer?.check()) continue;
          const cleanup = task.cleanup;
          task.cleanup = undefined;
          if (cleanup) runCleanup(cleanup);
          task.initial = false;
          const result = task.observer?.track(task.run);
          if (typeof result === "function") task.cleanup = result as () => void;
          else if (result && typeof result === "object" && "then" in result) {
            throw new RenderFault("async-effect", "Effects must return synchronously");
          }
        } catch (error) {
          reportFault(task.owner, error);
        }
      }
      this.visit(this.root, (owner) => {
        for (const check of owner.publicationChecks) {
          try {
            check();
          } catch (error) {
            reportFault(owner, error);
          }
        }
      });
    } finally {
      this.flushingEffects = false;
      if (this.hasRunnableEffects() || this.renders.size) this.requestEffects();
      this.finishIfSettled();
    }
  }

  private hasPendingWork(): boolean {
    return (
      this.domScheduled ||
      this.effectScheduled ||
      this.flushingDom ||
      this.flushingEffects ||
      this.reconciliationDepth > 0 ||
      this.renders.size > 0 ||
      this.hasRunnableEffects()
    );
  }

  private hasRunnableEffects(): boolean {
    return [...this.pendingEffects].some((task) => task.active && task.owner.isCommitted());
  }

  private makeObserver(task: Work): Observer {
    return createObserver({
      notify: () => {
        if (task.active) {
          if (task.owner.state === "suspended") return;
          if (this.effects.get(task.owner)?.includes(task)) {
            this.pendingEffects.add(task);
            this.requestEffects();
          } else {
            this.renders.add(task);
            if (!this.domScheduled) {
              this.domScheduled = true;
              afterPropagation(() => {
                this.domScheduled = false;
                this.flushDom();
              });
            }
          }
        }
      },
    });
  }

  private tasks(owner: Owner): Work[] {
    return [...(this.works.get(owner) ?? [])];
  }

  private subtree(root: Owner): Owner[] {
    const owners: Owner[] = [];
    const visit = (owner: Owner): void => {
      owners.push(owner);
      for (const child of owner.children.slice()) visit(child);
    };
    visit(root);
    return owners;
  }

  private finishIfSettled(): void {
    if (this.hasPendingWork()) return;
    this.recreationCounts.clear();
    this.rawReplacementCounts.clear();
    this.flushCount = 0;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
