import * as stylex from "@stylexjs/stylex";

// prettier-ignore
const styles = stylex.create({ card: { backgroundImage: 'url("./images/icon.svg")', width: "32px", height: "32px" } });

// prettier-ignore
export function Card() { const attrs = stylex.attrs(styles.card); return <div id="card" class={attrs.class ?? ""} />; }
