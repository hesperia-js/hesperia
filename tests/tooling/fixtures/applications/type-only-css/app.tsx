import "./before.css";
// dependency
import "./after.css";

export default function App(props: { children: () => unknown }) {
  return (
    <html>
      <head />
      <body>
        <main>CSS ownership</main>
        {props.children()}
      </body>
    </html>
  );
}
