import * as client from "hesperia/client";

type Candidate = readonly [Blob | string, `${number}w` | `${number}x`];

export function App() {
  const photo = new Blob(["photo"]);

  const reactive = client.state<Blob | string>(photo);

  const candidates = client.state<readonly Candidate[]>([
    [photo, "480w"],
    ["/large.svg", "2x"],
  ]);

  // prettier-ignore
  return <>
    <div src={reactive()} />
    <img src={photo} srcset={candidates()} />
    <video src={photo} poster={reactive()} />
    <picture><source srcset={[[photo, "1x"], ["/large.svg", "2x"]]} /><img src={photo} /></picture>
  </>;
}
