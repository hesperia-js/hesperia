import { PUBLIC_SHAPE } from "hesperia/config/public";

const lookup: Readonly<Record<string, unknown>> = PUBLIC_SHAPE;

export default function PublicValuesPage() {
  return (
    <main
      id="public-shape"
      data-ready="true"
      data-omitted-own={String(Object.hasOwn(PUBLIC_SHAPE, "omitted"))}
      data-omitted-is-undefined={String(lookup["omitted"] === undefined)}
      data-explicit-undefined-own={String(Object.hasOwn(PUBLIC_SHAPE, "explicitUndefined"))}
      data-explicit-undefined-is-undefined={String(PUBLIC_SHAPE.explicitUndefined === undefined)}
      data-explicit-null-own={String(Object.hasOwn(PUBLIC_SHAPE, "explicitNull"))}
      data-explicit-null-is-null={String(PUBLIC_SHAPE.explicitNull === null)}
    >
      <output id="explicit-undefined-value">{String(PUBLIC_SHAPE.explicitUndefined)}</output>
      <output id="explicit-null-value">{String(PUBLIC_SHAPE.explicitNull)}</output>
    </main>
  );
}
