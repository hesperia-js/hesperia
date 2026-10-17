import { AsyncBoundary, type Component } from "hesperia";
import * as client from "hesperia/client";
import { api, recordQueryCleanup } from "./api.ts";

async function QueryResult(props: Component.Props<{ queryKey: string }>) {
  const queryKey = props.queryKey();
  const query = api.queries.read(queryKey);

  client.cleanup(() => recordQueryCleanup(queryKey));

  const value = await query;
  return (
    <output id="query-result" data-query-key={queryKey}>
      {value()}
    </output>
  );
}

export default function QueryProbe(props: Component.Props<{ queryKey: string }>) {
  return (
    <AsyncBoundary fallback={<p id="query-fallback">Waiting for the query</p>}>
      <QueryResult queryKey={props.queryKey()} />
    </AsyncBoundary>
  );
}
