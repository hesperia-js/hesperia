import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  root: { color: "red" },

  dynamicColor: (color) => ({ color }),
});

export const staticAttrs = stylex.attrs(styles.root);

export const activeAttrs = stylex.attrs(styles.root, styles.dynamicColor("rebeccapurple"));

// eslint-disable-next-line no-constant-binary-expression
export const inactiveAttrs = stylex.attrs(styles.root, false && styles.dynamicColor("blue"));
