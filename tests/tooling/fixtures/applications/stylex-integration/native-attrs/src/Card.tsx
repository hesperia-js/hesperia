import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  root: { color: "red" },

  dynamicColor: (color: string) => ({ color }),

  mixedColor: (color: string) => ({ color, padding: 4 }),

  fallbackColor: (color: string | null) => ({ color: color ?? "red", padding: 4 }),
});

export function Card(props: { active: boolean; color: string }) {
  const attrs = () =>
    stylex.attrs(
      styles.root,
      props.active && styles.dynamicColor(props.color),
      styles.mixedColor(props.color),
      styles.fallbackColor(props.color),
    );

  return <button class={attrs().class ?? ""} style={attrs().style ?? ""} />;
}
