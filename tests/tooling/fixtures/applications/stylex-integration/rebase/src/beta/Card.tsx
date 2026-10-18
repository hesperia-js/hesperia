import { create as createStyles } from "@stylexjs/stylex";

export const classes = createStyles({
  icon: {
    backgroundImage: 'url( "./images/icon.svg?mode=small#symbol" )',
    backgroundColor: "blue",
    padding: "2px",
    position: "relative",
  },
});

// prettier-ignore
export function Beta() { return <div className={classes.icon} />; }
