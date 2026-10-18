import type { Page } from "hesperia";

export default function User(props: Page.Props<{ queryParams: { tab?: string } }>) {
  // prettier-ignore
  return <main id="user" data-param={props.params.id} data-tab={props.queryParams().get("tab") ?? ""}>
    User {props.params.id}
    <a id="user-tab-second" href="/users/one?tab=second">Second tab</a>
    <a id="user-tab-third" href="/users/one?tab=third">Third tab</a>
    <a id="user-two" href="/users/two?tab=third">User two</a>
  </main>;
}
