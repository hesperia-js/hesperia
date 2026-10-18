import { Signal } from "aeolia";
import { Owner, RenderFault } from "./owner.ts";

interface TrustedTypesFactory {
  isHTML(value: unknown): boolean;
}

/**
 * Generated unsafe HTML region. Each replacement owns a fresh host or fragment;
 * the native HTML sink retains the browser's Trusted Types enforcement.
 */
export function rawHTML(
  parent: Owner,
  slot: string,
  read: () => unknown,
  host: ((owner: Owner) => Element) | null,
  contextTag = parent.context.container.nodeType === 9
    ? "body"
    : (parent.context.container as Element).localName,
  namespaceURI = (parent.context.container.nodeType === 9
    ? null
    : (parent.context.container as Element).namespaceURI) ?? "http://www.w3.org/1999/xhtml",
): DocumentFragment {
  parent.assertActive();

  parent.context.warn("unsafe HTML inserts application-supplied markup without sanitization");

  const owner = new Owner(parent.context, parent, `${parent.identity}/${slot}`);
  owner.executingBody = false;
  const document = parent.context.document;
  const fragment = document.createDocumentFragment();
  const start = document.createComment("raw");
  const end = document.createComment("/raw");

  owner.nodes.add(start);

  owner.nodes.add(end);

  fragment.append(start, end);

  let current: Owner | undefined;
  let previous: unknown;
  let initialized = false;

  owner.context.scheduler.render(
    owner,
    () => {
      const value = read();

      if (initialized && Object.is(value, previous)) return;

      const factory = (
        document.defaultView as unknown as { trustedTypes?: TrustedTypesFactory } | null
      )?.trustedTypes;

      if (typeof value !== "string" && !factory?.isHTML(value)) {
        throw new RenderFault(
          "raw-html-input",
          "Raw HTML requires a string or platform TrustedHTML value",
        );
      }

      Signal.subtle.untrack(() => {
        if (initialized) owner.context.scheduler.requestRawReplacement(owner);

        current?.dispose();

        const next = new Owner(parent.context, owner, `${owner.identity}/content`);

        next.executingBody = false;

        try {
          let output: Node;

          if (host) {
            const element = host(next);

            if (element.childNodes.length)
              throw new RenderFault(
                "raw-html-host",
                "A raw HTML host cannot also contain managed children",
              );

            element.innerHTML = value as string;

            next.nodes.add(element);

            output = element;
          } else {
            const context = end.parentElement ?? document.createElementNS(namespaceURI, contextTag);
            const range = document.createRange();

            range.selectNodeContents(context);

            const parsed = range.createContextualFragment(value as string);

            for (const node of parsed.childNodes) next.nodes.add(node);

            output = parsed;
          }

          end.parentNode?.insertBefore(output, end);

          current = next;
          previous = value;
          initialized = true;

          if (parent.isCommitted()) {
            owner.commit();

            owner.context.scheduler.requestEffects();
          }
        } catch (error) {
          next.dispose(error);

          throw error;
        }
      });
    },
    true,
  );

  return fragment;
}
