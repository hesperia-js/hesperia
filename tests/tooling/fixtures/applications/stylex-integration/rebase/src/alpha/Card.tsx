import * as stylex from "@stylexjs/stylex";

export const classes = stylex.create({
  icon: {
    backgroundImage: 'url( "./images/icon.svg?mode=small#symbol" )',
    color: "red",
    marginTop: "1px",
    zIndex: 2,
  },
  escaped: {
    backgroundImage: 'url("./images/icon\\2d alt.svg?mode=small#symbol")',
  },
  embedded: { backgroundImage: 'url("data:image/svg+xml,%3Csvg%3E")' },
  public: { backgroundImage: 'url("/public/icons/icon.svg")' },
  remote: { backgroundImage: 'url("https://example.test/icon.svg")' },
});

// prettier-ignore
const unrelated = 'url("./images/icon.svg")';

// prettier-ignore
export function Alpha() { return <div className={classes.icon} data-note={unrelated} />; }
