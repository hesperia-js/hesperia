import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  root: (color: string) => ({
    color,
    backgroundImage: 'url("./images/icon.svg?mode=small#symbol")',
    maskImage: {
      default: "none",
      ":hover": 'url("./images/icon.svg?mode=small#symbol")',
    },
  }),
});

export function Card() {
  return <div />;
}
