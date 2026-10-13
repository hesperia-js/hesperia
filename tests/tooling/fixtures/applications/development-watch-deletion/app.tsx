export default function App(props: { children: () => unknown }) {
  // prettier-ignore
  return <html><head><title>Watch fixture</title></head><body>{props.children()}</body></html>;
}
