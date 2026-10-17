import type { PreparedRoute } from "./navigation.ts";

interface Interaction {
  readonly focus: number;
  readonly scroll: number;
}

/** @internal Saved browser position for one history entry, without retaining its DOM. */
export interface PresentationSnapshot {
  readonly focus: WeakRef<Element> | undefined;
  readonly focusId: string | undefined;
  readonly scroll: readonly [number, number];
}

/** Applies terminal route presentation without overriding a newer interaction. */
export class RoutePresentation {
  private readonly previousScrollRestoration: ScrollRestoration;
  private focusEpoch = 0;
  private scrollEpoch = 0;
  private lastScrollPosition: readonly [number, number];
  private lastFocused: Element | null = null;
  private readonly announce: (message: string) => void;
  private readonly announcementRegion: HTMLElement | undefined;
  private readonly temporary = new Set<() => void>();
  private readonly focusChanged = () => {
    this.focusEpoch++;
    this.lastFocused = this.window.document.activeElement;
  };
  private readonly scrollIntent = () => {
    this.scrollEpoch++;
  };
  private readonly scrollChanged = (event: Event) => {
    if (event.target === this.window || event.target === this.window.document) {
      const position = [this.window.scrollX, this.window.scrollY] as const;

      if (position[0] === this.lastScrollPosition[0] && position[1] === this.lastScrollPosition[1])
        return;

      this.lastScrollPosition = position;
    }

    this.scrollIntent();
  };

  constructor(
    private readonly window: Window,
    announce?: (message: string) => void,
  ) {
    this.previousScrollRestoration = window.history.scrollRestoration;
    this.lastScrollPosition = [window.scrollX, window.scrollY];
    // This owner restores saved positions. Browser restoration would race it
    // and report a native scroll as newer interaction during route preparation.
    window.history.scrollRestoration = "manual";

    if (announce) this.announce = announce;
    else {
      const region = window.document.createElement("div");

      region.setAttribute("role", "status");

      region.setAttribute("aria-live", "polite");

      region.setAttribute("aria-atomic", "true");

      region.style.cssText =
        "position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap";

      window.document.body.appendChild(region);

      this.announcementRegion = region;
      this.announce = (message) => {
        region.textContent = message;
      };
    }

    window.document.addEventListener("focusin", this.focusChanged);

    window.addEventListener("scroll", this.scrollChanged, true);

    window.addEventListener("wheel", this.scrollIntent, { passive: true });

    window.addEventListener("touchmove", this.scrollIntent, { passive: true });
  }

  begin(): Interaction {
    // Scroll events are queued; an event for this existing position can arrive
    // during preparation without representing a newer scroll.
    this.lastScrollPosition = [this.window.scrollX, this.window.scrollY];
    return { focus: this.focusEpoch, scroll: this.scrollEpoch };
  }

  capture(): PresentationSnapshot {
    const document = this.window.document;
    const focused = document.activeElement;
    const meaningful = focused !== document.body && focused !== document.documentElement;
    return {
      focus: meaningful && focused ? new WeakRef(focused) : undefined,
      focusId: meaningful && focused?.id ? focused.id : undefined,
      scroll: [this.window.scrollX, this.window.scrollY],
    };
  }

  commit(
    route: PreparedRoute,
    url: string,
    interaction: Interaction,
    restoration?: PresentationSnapshot,
  ): void {
    const document = this.window.document;
    const moveFocus =
      interaction.focus === this.focusEpoch ||
      (this.lastFocused !== null &&
        (!this.lastFocused.isConnected ||
          this.lastFocused.closest("[hidden], [inert], [disabled]") !== null));
    const moveScroll = interaction.scroll === this.scrollEpoch;

    if (route.title !== undefined) document.title = route.title;

    if (route.language !== undefined) document.documentElement.lang = route.language;

    let fragment: HTMLElement | null = null;
    const hash = new URL(url).hash;

    if (hash) {
      try {
        fragment = document.getElementById(decodeURIComponent(hash.slice(1)));
      } catch {
        /* Invalid escaped fragments have no target. */
      }
    }

    if (moveFocus) {
      const requested = route.focusTarget
        ? document.querySelector<HTMLElement>(route.focusTarget)
        : null;
      const saved = restoration?.focus?.deref();
      const restored =
        saved?.isConnected && saved.ownerDocument === document
          ? saved
          : restoration?.focusId
            ? document.getElementById(restoration.focusId)
            : null;
      const candidates = [
        requested,
        restored,
        fragment,
        ...document.querySelectorAll<HTMLElement>("main, [role='main']"),
        ...document.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
      ];

      for (const target of new Set(candidates)) {
        if (
          !target ||
          !("focus" in target) ||
          typeof target.focus !== "function" ||
          target === document.body ||
          target === document.documentElement ||
          target.closest("[hidden], [inert], [disabled]")
        )
          continue;

        let clearTemporary: (() => void) | undefined;

        if ((target as HTMLElement).tabIndex < 0 && !target.hasAttribute("tabindex")) {
          target.setAttribute("tabindex", "-1");

          const clear = () => {
            if (target.getAttribute("tabindex") === "-1") target.removeAttribute("tabindex");

            target.removeEventListener("blur", clear);

            this.temporary.delete(clear);
          };

          this.temporary.add(clear);

          clearTemporary = clear;

          target.addEventListener("blur", clear, { once: true });

          route.owners[0]?.onRelease(clear);
        }

        target.focus({ preventScroll: true });

        if (document.activeElement === target) break;

        clearTemporary?.();
      }
    }

    if (moveScroll) {
      if (fragment && !route.scroll && !restoration) fragment.scrollIntoView();
      else {
        const position = route.scroll ?? restoration?.scroll ?? [0, 0];

        this.window.scrollTo(position[0], position[1]);
      }
    }

    const announcement = route.announcement ?? document.title;

    if (announcement.trim()) this.announce(announcement);
    else
      route.owners[0]?.context.warn(
        "A committed page needs a document title or an announcement label",
      );
  }

  dispose(): void {
    if (this.window.history.scrollRestoration === "manual")
      this.window.history.scrollRestoration = this.previousScrollRestoration;

    this.window.document.removeEventListener("focusin", this.focusChanged);

    this.window.removeEventListener("scroll", this.scrollChanged, true);

    this.window.removeEventListener("wheel", this.scrollIntent);

    this.window.removeEventListener("touchmove", this.scrollIntent);

    for (const clear of this.temporary) clear();

    this.announcementRegion?.remove();
  }
}
