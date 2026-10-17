export default function App(props: { children: () => unknown }) {
  // oxfmt-ignore
  return <html><head><title>Deletion fixture</title></head><body>{props.children()}</body></html>;
}
