import { Connection } from "@t3tools/client-runtime/connection";
<<<<<<< HEAD
import { shellSnapshotLoaderLayer } from "@t3tools/client-runtime/state/shell";
import {
  threadSnapshotLoaderLayer,
  threadTranscriptLoaderLayer,
=======
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  boundedThreadSnapshotLoaderLayer,
  ThreadHistoryController,
>>>>>>> 25d5c7cacb99bc50056edc0ea8d201eac31cfdf4
} from "@t3tools/client-runtime/state/threads";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import type { FoundationHotModule } from "../lib/foundation-fast-refresh";
import { hotSwappableAtomRuntime } from "../lib/hot-swappable-atom-runtime";
import { runtimeContextLayer } from "../lib/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import {
  mobileBackgroundActivityObserverLayer,
  mobileBackgroundActivityReporterLayer,
} from "./background-activity";
import { connectionPlatformLayer } from "./platform";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

const snapshotLoaderLayer = Layer.mergeAll(
<<<<<<< HEAD
  threadSnapshotLoaderLayer,
  threadTranscriptLoaderLayer,
  shellSnapshotLoaderLayer,
=======
  boundedThreadSnapshotLoaderLayer,
  ShellSnapshotLoader.layer,
  ThreadHistoryController.layer,
>>>>>>> 25d5c7cacb99bc50056edc0ea8d201eac31cfdf4
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof snapshotLoaderLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer
  | typeof mobileBackgroundActivityObserverLayer
  | typeof mobileBackgroundActivityReporterLayer;

const providedClientConnectionLayer = snapshotLoaderLayer.pipe(
  Layer.provideMerge(
    Connection.layerWithOptions({ usageLimitSources: true, usageLimitsCommand: true }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      runtimeContextLayer,
      providedConnectionPlatformLayer,
      mobileBackgroundActivityObserverLayer,
    ),
  ),
);

const connectionLayer = mobileBackgroundActivityReporterLayer.pipe(
  Layer.provideMerge(providedClientConnectionLayer),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = hotSwappableAtomRuntime({
  id: "t3.mobile.connection-runtime",
  hotModule: typeof module === "undefined" ? undefined : module.hot,
  registry: appAtomRegistry,
  layer: connectionLayer,
});
