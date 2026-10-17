import { mount } from "hesperia";
import BadSri from "./bad-sri.html" with { type: "html" };

export function mountBadMarkup(target: HTMLElement): void {
  mount(target, BadSri, {});
}
