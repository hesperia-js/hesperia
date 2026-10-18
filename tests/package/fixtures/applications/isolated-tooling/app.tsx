import "./app.css";

export default function App(props: { children: () => unknown }) {
  return (
    <html>
      <head>
        <title>Installed app</title>
      </head>
      <body>{props.children()}</body>
    </html>
  );
}
