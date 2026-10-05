import { Connection } from "@t3tools/client-runtime/connection";
<<<<<<< HEAD
import { shellSnapshotLoaderLayer } from "@t3tools/client-runtime/state/shell";
import {
  threadSnapshotLoaderLayer,
  threadTranscriptLoaderLayer,
} from "@t3tools/client-runtime/state/threads";
import { pullRequestDiffLoaderLayer } from "@t3tools/client-runtime/state/pull-requests";
=======
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  boundedThreadSnapshotLoaderLayer,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
>>>>>>> 25d5c7cacb99bc50056edc0ea8d201eac31cfdf4
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import {
  backgroundActivityObserverLayer,
  backgroundActivityReporterLayer,
} from "../lib/backgroundActivityReporter";
import { connectionPlatformLayer } from "./platform";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

const snapshotLoaderLayer = Layer.mergeAll(
<<<<<<< HEAD
  threadSnapshotLoaderLayer,
  threadTranscriptLoaderLayer,
  shellSnapshotLoaderLayer,
  pullRequestDiffLoaderLayer,
=======
  boundedThreadSnapshotLoaderLayer,
  ShellSnapshotLoader.layer,
  ThreadHistoryController.layer,
  PullRequestDiffLoader.layer,
>>>>>>> 25d5c7cacb99bc50056edc0ea8d201eac31cfdf4
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof snapshotLoaderLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer
  | typeof backgroundActivityObserverLayer
  | typeof backgroundActivityReporterLayer;

const providedClientConnectionLayer = snapshotLoaderLayer.pipe(
  Layer.provideMerge(
    Connection.layerWithOptions({
      environmentThemes: true,
      usageLimitSources: true,
      usageLimitsCommand: true,
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      runtimeContextLayer,
      providedConnectionPlatformLayer,
      backgroundActivityObserverLayer,
    ),
  ),
);

const connectionLayer = backgroundActivityReporterLayer.pipe(
  Layer.provideMerge(providedClientConnectionLayer),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer);
