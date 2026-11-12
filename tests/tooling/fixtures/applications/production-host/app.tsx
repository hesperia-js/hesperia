import "./app.css";

export default function App(props: { children: () => unknown }) {
  return (
    <html>
      <head>
        <title>Hosted app</title>
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%201%201'%3E%3Cpath%20d='M0%200h1v1H0z'/%3E%3C/svg%3E"
        />
      </head>
      <body>{props.children()}</body>
    </html>
  );
}
