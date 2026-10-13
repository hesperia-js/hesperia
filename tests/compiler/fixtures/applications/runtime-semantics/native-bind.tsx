import * as client from "hesperia/client";

export default function App() {
  const circle = client.bind<SVGCircleElement>();

  const result = client.state("");

  client.effect(() => result.set(circle().namespaceURI));

  // prettier-ignore
  return <><svg><circle bind={circle} /></svg><output>{result()}</output></>;
}
