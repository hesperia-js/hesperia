import { createGraph, defineContract } from "aeolia";
import type { GraphId, Projection, Readable, StoreKey, StreamStatus, StreamStore } from "aeolia";
import type { Accessor } from "hesperia";
import type {
  ChannelCarrier as MainChannelCarrier,
  ChannelDeclaration as MainChannelDeclaration,
  ChannelProjection as MainChannelProjection,
  ChannelSendOptions as MainChannelSendOptions,
  ChannelView as MainChannelView,
  StandaloneChannel as MainStandaloneChannel,
} from "hesperia";
import type {
  ChannelCarrier as AeoliaChannelCarrier,
  ChannelDeclaration as AeoliaChannelDeclaration,
  ChannelProjection as AeoliaChannelProjection,
  ChannelSendOptions as AeoliaChannelSendOptions,
  ChannelView as AeoliaChannelView,
  StandaloneChannel as AeoliaStandaloneChannel,
} from "hesperia/aeolia";

type Opening = { readonly roomId: string };

type OtherOpening = { readonly userId: number };

type Incoming = { readonly text: string };

type Message = { readonly command: string };

type Result = { readonly closedAt: number };

declare const room: MainChannelDeclaration<Opening, Incoming, Message, Result>;

declare const voidRoom: MainChannelDeclaration<void, Incoming, Message, Result>;

declare const carrier: MainChannelCarrier<Opening>;

declare const operationIdentity: object;

declare const incomingPayload: Incoming;

declare const message: Message;

declare const view: MainChannelView<Incoming, Message, Result>;

declare const standalone: MainStandaloneChannel<Incoming, Message, Result>;

declare const aeoliaRoom: AeoliaChannelDeclaration<Opening, Incoming, Message, Result>;

declare const wrongOpening: MainChannelDeclaration<OtherOpening, Incoming, Message, Result>;

declare const wrongMessage: MainChannelDeclaration<Opening, Incoming, number, Result>;

declare const wrongResult: MainChannelDeclaration<Opening, Incoming, Message, string>;

function checkRawAeoliaContractTypes(): void {
  const contract = defineContract({
    namespace: "channel-types",
    operations: { room, voidRoom },
  });

  const graph = createGraph({ contract });

  const incoming: StreamStore<Incoming> = graph.api.room.incoming(carrier);

  const voidCarrier: MainChannelCarrier<void> = {
    opening: undefined,
    operation: operationIdentity,
  };

  const voidIncoming: StreamStore<Incoming> = graph.api.voidRoom.incoming(voidCarrier);

  // @ts-expect-error A void channel carrier still requires its explicit opening field.
  const missingOpening: MainChannelCarrier<void> = { operation: operationIdentity };

  // @ts-expect-error The raw contract exposes a tree member, not a channel acquisition call.
  graph.api.room();

  // @ts-expect-error A void-opening channel declaration is still a tree member, not a callable.
  graph.api.voidRoom();

  // @ts-expect-error The incoming stream always requires its ChannelCarrier, including for void openings.
  graph.api.voidRoom.incoming();

  // @ts-expect-error A channel declaration cannot change its opening input type.
  const rejectedOpening: MainChannelDeclaration<Opening, Incoming, Message, Result> = wrongOpening;

  // @ts-expect-error A channel declaration cannot change its outgoing message type.
  const rejectedMessage: MainChannelDeclaration<Opening, Incoming, Message, Result> = wrongMessage;

  // @ts-expect-error A channel declaration cannot change its terminal result type.
  const rejectedResult: MainChannelDeclaration<Opening, Incoming, Message, Result> = wrongResult;

  // @ts-expect-error The raw incoming member accepts a carrier, not an outgoing message.
  graph.api.room.incoming(message);

  void [incoming, voidIncoming, missingOpening, rejectedOpening, rejectedMessage, rejectedResult];
}

function checkPublicChannelTypes(): void {
  const sameBrandFromSubpath: MainChannelDeclaration<Opening, Incoming, Message, Result> =
    aeoliaRoom;

  const sameBrandFromMain: AeoliaChannelDeclaration<Opening, Incoming, Message, Result> = room;

  const ownerView: AeoliaChannelView<Incoming, Message, Result> = view;

  const standaloneView: AeoliaStandaloneChannel<Incoming, Message, Result> = standalone;

  const ownerCarrier: AeoliaChannelCarrier<Opening> = carrier;

  const sendOptions: MainChannelSendOptions = {
    timeoutMs: 250,
    signal: new AbortController().signal,
  };

  const sendOptionsFromSubpath: AeoliaChannelSendOptions = sendOptions;

  const incomingValue: Accessor<Incoming | undefined> = view.value;

  const incomingPresence: Accessor<boolean> = view.available;

  const incomingPending: Accessor<boolean> = view.pending;

  const incomingError: Accessor<unknown> = view.error;

  const incomingStatus: Accessor<StreamStatus> = view.status;

  const graphId: GraphId = view.graph;

  const key: StoreKey = view.key;

  const ownerTerminal: PromiseLike<Result> = view;

  const standaloneTerminal: PromiseLike<Result> = standalone;

  const sendRun = view.send(message, sendOptions);

  const sendId: number = sendRun.id;

  const sendSignal: AbortSignal = sendRun.signal;

  const sendOutcome: PromiseLike<void> = sendRun;

  sendRun.cancel();

  // @ts-expect-error An incoming payload is not an outgoing channel message.
  view.send(incomingPayload);

  const standaloneRun = standalone.send(message);

  // @ts-expect-error A standalone channel send also accepts only outgoing messages.
  standalone.send(incomingPayload);

  const capacity: Promise<void> = view.waitForCapacity({ signal: sendSignal });

  const finished: Promise<void> = view.finish();

  view.close();

  const accumulated = view.project({ kind: "accumulate", max: 8 });

  const ownerAccumulated: MainChannelProjection<Incoming, readonly Incoming[]> = accumulated;

  const accumulatedValue: Accessor<readonly Incoming[]> = accumulated.value;

  accumulated.close();

  // @ts-expect-error Owner projections do not expose the shared StreamStore.
  void accumulated.source;

  // @ts-expect-error Owner projections cannot send messages.
  accumulated.send(message);

  // @ts-expect-error Owner projections are not terminal-awaitable channel handles.
  void accumulated.then;

  const reduced = view.project({
    kind: "reduce",
    initial: 0,
    step: (total, message) => total + message.text.length,
  });

  const ownerReduced: MainChannelProjection<Incoming, number> = reduced;

  const reducedValue: Accessor<number> = reduced.value;

  const standaloneValue: Readable<Incoming | undefined> = standalone.value;

  const standalonePresence: Readable<boolean> = standalone.available;

  const standalonePending: Readable<boolean> = standalone.pending;

  const standaloneError: Readable<unknown> = standalone.error;

  const standaloneStatus: Readable<StreamStatus> = standalone.status;

  const standaloneAccumulated: Projection<readonly Incoming[]> = standalone.project({
    kind: "accumulate",
    max: 8,
  });

  const standaloneReduced: Projection<string> = standalone.project({
    kind: "reduce",
    initial: "",
    step: (text, message) => text + message.text,
  });

  const subpathProjection: AeoliaChannelProjection<Incoming, number> = ownerReduced;

  // @ts-expect-error A send deadline must be numeric.
  const invalidOptions: MainChannelSendOptions = { timeoutMs: "250" };

  void [
    sameBrandFromSubpath,
    sameBrandFromMain,
    ownerView,
    standaloneView,
    ownerCarrier,
    sendOptionsFromSubpath,
    incomingValue,
    incomingPresence,
    incomingPending,
    incomingError,
    incomingStatus,
    graphId,
    key,
    ownerTerminal,
    standaloneTerminal,
    standaloneRun,
    sendId,
    sendSignal,
    sendOutcome,
    capacity,
    finished,
    ownerAccumulated,
    accumulatedValue,
    ownerReduced,
    reducedValue,
    standaloneValue,
    standalonePresence,
    standalonePending,
    standaloneError,
    standaloneStatus,
    standaloneAccumulated,
    standaloneReduced,
    subpathProjection,
    invalidOptions,
  ];
}

void checkRawAeoliaContractTypes;
void checkPublicChannelTypes;
