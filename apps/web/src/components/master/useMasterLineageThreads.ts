import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useArchivedThreadSnapshots } from "~/lib/archivedThreadsState";
import { useThreadShells } from "~/state/entities";
import { mergeLiveAndArchivedThreads } from "./MasterStatusBoard.logic";

/**
 * The one "threads + archived lineage" source for the Master sidebar and
 * board, so both resolve Card ownership from identical data. The live shell
 * stream excludes archived threads, but an archived Master still owns its
 * active Cards, so archived records are merged in underneath the live rows.
 *
 * Mounting this subscribes to the archived snapshot of each environment:
 * only mount it where Master lineage is actually rendered.
 */
export function useMasterLineageThreads(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<EnvironmentThreadShell> {
  const liveThreads = useThreadShells();
  const { snapshots, refresh } = useArchivedThreadSnapshots(environmentIds);

  // A thread leaving the live stream may have just been archived (possibly on
  // another device), which the cached archived snapshot can't know about yet.
  // Arrivals need no refetch: live rows already win over archived ones.
  const previousLiveKeysRef = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const watched = new Set<string>(environmentIds);
    const liveKeys = new Set<string>();
    for (const thread of liveThreads) {
      if (watched.has(thread.environmentId)) liveKeys.add(`${thread.environmentId}:${thread.id}`);
    }
    const previous = previousLiveKeysRef.current;
    previousLiveKeysRef.current = liveKeys;
    if (previous === null) return;
    for (const key of previous) {
      if (!liveKeys.has(key)) {
        refresh();
        return;
      }
    }
  }, [environmentIds, liveThreads, refresh]);

  return useMemo(() => {
    const archived: EnvironmentThreadShell[] = [];
    for (const { environmentId, snapshot } of snapshots) {
      for (const thread of snapshot.threads) archived.push({ ...thread, environmentId });
    }
    return mergeLiveAndArchivedThreads(liveThreads, archived);
  }, [liveThreads, snapshots]);
}
