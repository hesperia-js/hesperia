import palette from "./palette.dat" with { type: "palette" };
import detail from "./src/detail.ts";
import { SETTINGS } from "hesperia/config/public";

export default function App() {
  return (
    <html>
      <head></head>
      <body>
        {palette}
        {detail}
        {String(SETTINGS.flags[2])}
      </body>
    </html>
  );
}
