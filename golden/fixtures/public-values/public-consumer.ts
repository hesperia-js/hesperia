import { PUBLIC_SHAPE } from "hesperia/config/public";

const explicitUndefined: undefined = PUBLIC_SHAPE.explicitUndefined;
const explicitUndefinedValue: typeof PUBLIC_SHAPE.explicitUndefined = undefined;
const explicitNull: null = PUBLIC_SHAPE.explicitNull;
const explicitNullValue: typeof PUBLIC_SHAPE.explicitNull = null;

// @ts-expect-error omitted keys are not part of the generated public shape
const omitted: never = PUBLIC_SHAPE.omitted;

void [explicitUndefined, explicitUndefinedValue, explicitNull, explicitNullValue, omitted];
