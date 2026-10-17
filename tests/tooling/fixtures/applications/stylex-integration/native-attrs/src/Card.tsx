import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  root: { color: "red" },

  dynamicColor: (color: string) => ({ color }),
});

export function Card(props: { active: boolean; color: string }) {
  const attrs = () => stylex.attrs(styles.root, props.active && styles.dynamicColor(props.color));

  return <button class={attrs().class ?? ""} style={attrs().style ?? ""} />;
}
