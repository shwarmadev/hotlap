export interface MasterBoardThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly forkedFrom?: { readonly threadId: string } | undefined;
  readonly archivedAt?: string | null | undefined;
}

export interface MasterBoardModel<T extends MasterBoardThread> {
  readonly master: T;
  readonly cards: readonly T[];
  readonly peerMasters: readonly T[];
}

/**
 * Which sidebar shelf a live thread sits on. Shelves are exclusive, as in the
 * default sidebar: a thread renders in exactly one place.
 */
export type MasterShelf = "pinned" | "active" | "snoozed" | "settled";

/** A pinned thread; a pinned Master carries its active Cards with it. */
export interface MasterPinnedEntry<T extends MasterBoardThread> {
  readonly thread: T;
  readonly cards: readonly T[];
}

/**
 * A Master and its Cards on one shelf. `structural` means the Master itself
 * lives elsewhere (another shelf, or archived) and only heads its Cards here:
 * render it as an inert heading, never as a second navigable copy.
 */
export interface MasterShelfBoard<T extends MasterBoardThread> {
  readonly master: T;
  readonly cards: readonly T[];
  readonly structural: boolean;
}

export interface MasterWorkspaceProject<T extends MasterBoardThread> {
  readonly environmentId: string;
  readonly projectId: string;
  readonly masters: readonly MasterShelfBoard<T>[];
  readonly oneOffs: readonly T[];
  readonly orphanCards: readonly T[];
  readonly visibleCount: number;
}

export interface MasterWorkspaceModel<T extends MasterBoardThread> {
  readonly pinned: readonly MasterPinnedEntry<T>[];
  readonly activeProjects: readonly MasterWorkspaceProject<T>[];
  readonly snoozedProjects: readonly MasterWorkspaceProject<T>[];
  readonly settledProjects: readonly MasterWorkspaceProject<T>[];
}

const MASTER_TITLE = /^master\s*:/i;
const CARD_TITLE = /^card\s*:/i;

export function isMasterThreadTitle(title: string): boolean {
  return MASTER_TITLE.test(title.trim());
}

export function isCardThreadTitle(title: string): boolean {
  return CARD_TITLE.test(title.trim());
}

function threadKey(thread: { readonly environmentId: string; readonly id: string }): string {
  return `${thread.environmentId}:${thread.id}`;
}

function newestFirst<T extends MasterBoardThread>(left: T, right: T): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  const difference =
    (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  return difference === 0 ? left.id.localeCompare(right.id) : difference;
}

/**
 * Live shells plus archived records, one row per thread. The live stream is
 * authoritative: an archived snapshot can be stale (a thread unarchived on
 * another device), so it only fills in threads the live stream lacks.
 */
export function mergeLiveAndArchivedThreads<T extends MasterBoardThread>(
  live: readonly T[],
  archived: readonly T[],
): readonly T[] {
  if (archived.length === 0) return live;
  const liveKeys = new Set(live.map(threadKey));
  const merged = [...live];
  for (const thread of archived) {
    if (!liveKeys.has(threadKey(thread))) merged.push(thread);
  }
  return merged;
}

/**
 * Card -> owning Master, keyed by scoped thread key. The nearest Master in a
 * Card's fork chain owns it. Lineage is resolved across the whole environment
 * (a Card often lives in another project/worktree than its Master) and walks
 * archived records too, since lineage is durable data, not a visibility
 * concern. Both the sidebar and the board read ownership from here.
 */
export function resolveCardOwners<T extends MasterBoardThread>(
  threads: readonly T[],
): ReadonlyMap<string, T> {
  const byKey = new Map(threads.map((thread) => [threadKey(thread), thread]));
  const owners = new Map<string, T>();
  for (const card of threads) {
    if (!isCardThreadTitle(card.title)) continue;
    const visited = new Set<string>();
    let parentId = card.forkedFrom?.threadId;
    while (parentId !== undefined && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byKey.get(`${card.environmentId}:${parentId}`);
      if (parent !== undefined && isMasterThreadTitle(parent.title)) {
        owners.set(threadKey(card), parent);
        break;
      }
      parentId = parent?.forkedFrom?.threadId;
    }
  }
  return owners;
}

/**
 * Projects the sidebar. Every known project gets an active row, even with no
 * threads yet. Pinned, snoozed and settled threads move to their own shelves.
 * A pinned Master takes its active Cards into the Pinned shelf; on the other
 * shelves, a Master owning Cards there (or an archived one) appears as a
 * structural header.
 */
export function deriveMasterWorkspace<T extends MasterBoardThread>(input: {
  readonly threads: readonly T[];
  readonly projects: ReadonlyArray<{ readonly environmentId: string; readonly id: string }>;
  readonly shelfOf: (thread: T) => MasterShelf;
}): MasterWorkspaceModel<T> {
  const owners = resolveCardOwners(input.threads);
  const live = input.threads.filter((thread) => thread.archivedAt == null);
  const shelfByKey = new Map(live.map((thread) => [threadKey(thread), input.shelfOf(thread)]));
  const projectOrder = new Map(
    input.projects.map((project, index) => [`${project.environmentId}:${project.id}`, index]),
  );
  const orderOf = (row: { environmentId: string; projectId: string }) =>
    projectOrder.get(`${row.environmentId}:${row.projectId}`) ?? Number.MAX_SAFE_INTEGER;
  const pinnedCards = new Map<string, T[]>();
  const pinned = live
    .filter((thread) => shelfByKey.get(threadKey(thread)) === "pinned")
    .map((thread) => {
      const cards: T[] = [];
      if (isMasterThreadTitle(thread.title)) pinnedCards.set(threadKey(thread), cards);
      return { thread, cards };
    });

  const build = (
    shelf: MasterShelf,
    seedProjects: boolean,
  ): readonly MasterWorkspaceProject<T>[] => {
    const rows = new Map<
      string,
      { environmentId: string; projectId: string; masters: T[]; oneOffs: T[]; orphanCards: T[] }
    >();
    const bucket = (environmentId: string, projectId: string) => {
      const key = `${environmentId}:${projectId}`;
      let entry = rows.get(key);
      if (!entry) {
        entry = { environmentId, projectId, masters: [], oneOffs: [], orphanCards: [] };
        rows.set(key, entry);
      }
      return entry;
    };
    if (seedProjects) {
      for (const project of input.projects) bucket(project.environmentId, project.id);
    }
    const members = live.filter((thread) => shelfByKey.get(threadKey(thread)) === shelf);
    const memberKeys = new Set(members.map(threadKey));
    const cardsByOwner = new Map<string, T[]>();
    const mastersByKey = new Map<string, T>();
    for (const thread of members) {
      if (isMasterThreadTitle(thread.title)) {
        mastersByKey.set(threadKey(thread), thread);
      } else if (isCardThreadTitle(thread.title)) {
        const owner = owners.get(threadKey(thread));
        if (!owner) {
          bucket(thread.environmentId, thread.projectId).orphanCards.push(thread);
          continue;
        }
        const pinnedOwnerCards = shelf === "active" ? pinnedCards.get(threadKey(owner)) : undefined;
        if (pinnedOwnerCards) {
          pinnedOwnerCards.push(thread);
          continue;
        }
        mastersByKey.set(threadKey(owner), owner);
        const cards = cardsByOwner.get(threadKey(owner)) ?? [];
        cards.push(thread);
        cardsByOwner.set(threadKey(owner), cards);
      } else {
        bucket(thread.environmentId, thread.projectId).oneOffs.push(thread);
      }
    }
    for (const master of mastersByKey.values()) {
      bucket(master.environmentId, master.projectId).masters.push(master);
    }
    return [...rows.values()]
      .sort((left, right) => orderOf(left) - orderOf(right))
      .map((row) => ({
        environmentId: row.environmentId,
        projectId: row.projectId,
        masters: row.masters.sort(newestFirst).map((master) => ({
          master,
          cards: (cardsByOwner.get(threadKey(master)) ?? []).sort(newestFirst),
          structural: !memberKeys.has(threadKey(master)),
        })),
        oneOffs: row.oneOffs.sort(newestFirst),
        orphanCards: row.orphanCards.sort(newestFirst),
        // Structural Master headers (owned elsewhere or archived) don't count.
        visibleCount:
          row.masters.filter((master) => memberKeys.has(threadKey(master))).length +
          row.masters.reduce(
            (count, master) => count + (cardsByOwner.get(threadKey(master))?.length ?? 0),
            0,
          ) +
          row.oneOffs.length +
          row.orphanCards.length,
      }));
  };

  const activeProjects = build("active", true);
  for (const cards of pinnedCards.values()) cards.sort(newestFirst);
  return {
    pinned,
    activeProjects,
    snoozedProjects: build("snoozed", false),
    settledProjects: build("settled", false),
  };
}

/**
 * A project group's rows in render order, minus structural Master headings,
 * so every navigable thread appears exactly once across shelves. Drives
 * mod+1..9 and next/previous thread.
 */
export function navigableRows<T extends MasterBoardThread>(group: MasterWorkspaceProject<T>): T[] {
  return [
    ...group.masters.flatMap((board) =>
      board.structural ? [...board.cards] : [board.master, ...board.cards],
    ),
    ...group.oneOffs,
    ...group.orphanCards,
  ];
}

/**
 * Where to go after parking (settling or snoozing) the open thread: the next
 * row after it, wrapping around, that isn't parked. Null when the thread isn't
 * on screen or nothing else qualifies; callers then start a new thread.
 */
export function nextUnparkedKey(
  orderedKeys: readonly string[],
  currentKey: string,
  isParked: (key: string) => boolean,
): string | null {
  const index = orderedKeys.indexOf(currentKey);
  if (index === -1) return null;
  return (
    [...orderedKeys.slice(index + 1), ...orderedKeys.slice(0, index)].find(
      (key) => !isParked(key),
    ) ?? null
  );
}

/**
 * The board for a Master, or for a Card's owning Master. `threads` must carry
 * the same environment-wide, archive-aware lineage the sidebar uses, so the
 * two always agree about who owns a Card.
 */
export function deriveMasterBoard<T extends MasterBoardThread>(
  activeThread: T,
  threads: readonly T[],
): MasterBoardModel<T> | null {
  const environmentThreads = threads.filter(
    (thread) => thread.environmentId === activeThread.environmentId,
  );
  const owners = resolveCardOwners(environmentThreads);
  const master = isMasterThreadTitle(activeThread.title)
    ? activeThread
    : isCardThreadTitle(activeThread.title)
      ? (owners.get(threadKey(activeThread)) ?? null)
      : null;
  if (master === null) return null;

  return {
    master,
    cards: environmentThreads
      .filter(
        (thread) => thread.archivedAt == null && owners.get(threadKey(thread))?.id === master.id,
      )
      .sort(newestFirst),
    // Archived Masters may own active Cards, but must not reappear as
    // navigable peer work.
    peerMasters: environmentThreads
      .filter(
        (thread) =>
          thread.id !== master.id &&
          thread.projectId === master.projectId &&
          thread.archivedAt == null &&
          isMasterThreadTitle(thread.title),
      )
      .sort(newestFirst),
  };
}
