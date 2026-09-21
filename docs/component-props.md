# Component props

Reader: a junior engineer familiar with TypeScript functions and JSX.

Component props let a parent supply changing values to a child without running
the child's body again; their declared types determine how the child reads them.

Declare the incoming values inside `Component.Props`. A value such as a string
becomes an accessor in the body: a function that reads the current value and
records the reactive dependency.

```tsx
import { type Component } from "hesperia";

function Greeting(props: Component.Props<{ name: string }>) {
  return <span>Hello, {props.name()}!</span>;
}

export default function App() {
  return <Greeting name="Halk" />;
}
```

The parent passes a string. The child calls `props.name()` to read it. A later
change updates the rendered text through Aeolia's signals. The child normally
keeps its existing lifetime, including its state and native elements.

A component assigned to a variable can also use an arrow or a function
expression, such as `const Greeting = function (props: Component.Props<Props>)`.
Its declared props follow the same rules. A named function expression can refer
to itself through JSX for recursive children; calling the component directly
still raises a fault. Ordinary callback functions retain their usual behavior.

An `if` statement in a component body runs during that lifetime's setup. A later
signal update does not execute the body or that statement again. Use a JSX
conditional expression when the rendered branch needs to follow a changing
accessor. An `if` inside an effect runs on each execution of that effect; an `if`
inside an event handler runs when the handler is called. `throw` preserves the
thrown value, and an exception from an effect follows Hesperia's rendering-fault
path to the nearest active error boundary.

A required function prop remains directly callable. A function prop whose type
also allows `undefined` becomes an accessor, just like other values. Read the
accessor first, then call its result if present.

| Declared input                      | Read or call inside the child |
| ----------------------------------- | ----------------------------- |
| `name: string`                      | `props.name()`                |
| `onSave: () => void`                | `props.onSave()`              |
| `onSave?: () => void`               | `props.onSave()?.()`          |
| `onSave: (() => void) \| undefined` | `props.onSave()?.()`          |

The last two rows allow the same values, but differ in whether the parent must
supply the prop. The `?` permits omission. A required prop must be present even
when its value is `undefined`; missing it produces a checking error and a runtime
fault if unchecked code reaches the component.

```tsx
import { type Component } from "hesperia";
import * as client from "hesperia/client";

function SaveButton(props: Component.Props<{ onSave?: () => void }>) {
  return <button on:click={() => props.onSave()?.()}>Save</button>;
}

export default function App() {
  const callback = client.state<(() => void) | undefined>(() => console.log("Saved"));
  return (
    <section>
      <SaveButton onSave={callback()} />
      <button on:click={() => callback.set(undefined)}>Disable saving</button>
    </section>
  );
}
```

Clearing this callback publishes `undefined` through its accessor. Supplying a
new callback updates the same accessor. Neither transition needs a new child
lifetime.

The reserved `bind` attribute follows its own attachment rules. A child receives
the writable endpoint of a binding, rather than a value accessor. Changing an
optional binding between absent and present may recreate that child. This is
different from changing an optional callback.

The compiler uses TypeScript's resolved prop types to generate the runtime
contract. A compiler error about an unsupported prop contract identifies an
implementation gap; it does not establish a new restriction on Hesperia's design.
