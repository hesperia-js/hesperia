import "./app.css";

export default function App(props: { children: () => unknown }) {
  return (
    <html>
      <head>
        <title>Generated asset relocation</title>
        <link
          rel="stylesheet"
          href="/asset-controls.css"
          crossOrigin="anonymous"
          integrity="sha256-+8chqzQauzujwYKmYR0FNA5nwYVFTQ2VriPj6QW5qJ4="
        />
      </head>
      <body>{props.children()}</body>
    </html>
  );
}
