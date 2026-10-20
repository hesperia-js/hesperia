import Image from "./image.html" with { type: "html" };
import Video from "./video.html" with { type: "html" };
import Script from "./script.html" with { type: "html" };

export default function App() {
  const blob = new Blob(["image"], { type: "image/png" });
  const sourceSet = [
    [blob, "480w"],
    ["/large.png", "960w"],
  ] as const;

  return (
    <html>
      <head />
      <body>
        <Image src={blob} srcset={sourceSet} />
        <Video src={blob} poster={blob} />
        <img src={blob} srcset={sourceSet} />
        <video src={blob} poster={blob} />
        <Script />
        {/* rejected */}
      </body>
    </html>
  );
}
