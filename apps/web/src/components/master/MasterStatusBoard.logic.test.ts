import { describe, expect, it } from "vite-plus/test";

import {
  deriveMasterBoard,
  deriveMasterWorkspace,
  isCardThreadTitle,
  isMasterThreadTitle,
  mergeLiveAndArchivedThreads,
  navigableRows,
  nextUnparkedKey,
  type MasterBoardThread,
  type MasterShelf,
} from "./MasterStatusBoard.logic";

interface TestThread extends MasterBoardThread {
  readonly shelf?: MasterShelf;
}

function thread(id: string, title: string, options: Partial<TestThread> = {}): TestThread {
  return {
    id,
    title,
    environmentId: "env-a",
    projectId: "orchard",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...options,
  };
}

const ARCHIVED = "2026-09-10T00:00:00.000Z";

function workspace(threads: readonly TestThread[], projectIds: readonly string[] = []) {
  return deriveMasterWorkspace({
    threads,
    projects: projectIds.map((id) => ({ environmentId: "env-a", id })),
    shelfOf: (item) => item.shelf ?? "active",
  });
}

describe("deriveMasterWorkspace", () => {
  it("omits known projects that have no threads", () => {
    const master = thread("master", "Master: Harvest", { projectId: "orchard" });

    const model = workspace([master], ["orchard", "empty-greenhouse"]);

    expect(model.activeProjects.map((group) => group.projectId)).toEqual(["orchard"]);
  });

  it("files work under its shelf, keeping a Card with its Master across worktrees", () => {
    const master = thread("master", "Master: Harvest");
    const card = thread("card", "Card: Prune", {
      projectId: "orchard-worktree",
      forkedFrom: { threadId: master.id },
    });
    const chat = thread("chat", "Quick question");
    const snoozed = thread("snoozed", "Later question", { shelf: "snoozed" });
    const settledMaster = thread("settled-master", "Master: Done", {
      projectId: "barn",
      shelf: "settled",
    });

    const model = workspace([master, card, chat, snoozed, settledMaster], ["orchard", "barn"]);

    const orchard = model.activeProjects.find((group) => group.projectId === "orchard");
    expect(orchard?.masters[0]?.cards).toEqual([card]);
    expect(orchard?.oneOffs).toEqual([chat]);
    expect(model.snoozedProjects).toHaveLength(1);
    expect(model.snoozedProjects[0]?.oneOffs).toEqual([snoozed]);
    expect(model.settledProjects[0]).toMatchObject({ projectId: "barn", visibleCount: 1 });
  });

  it("keeps Cards without Master lineage in an explicit orphan fallback", () => {
    const master = thread("master", "Master: Harvest");
    const orphan = thread("orphan", "Card: Imported", { projectId: "imports" });

    const model = workspace([master, orphan]);

    expect(
      model.activeProjects.find((group) => group.projectId === "imports")?.orphanCards,
    ).toEqual([orphan]);
  });

  it("keeps an archived Master as the structural owner of its live Cards", () => {
    const archivedMaster = thread("master", "Master: Archived", { archivedAt: ARCHIVED });
    const archivedParent = thread("parent", "Card: Old parent", {
      archivedAt: ARCHIVED,
      forkedFrom: { threadId: archivedMaster.id },
    });
    const activeCard = thread("active", "Card: Continuation", {
      projectId: "orchard-worktree",
      forkedFrom: { threadId: archivedParent.id },
    });
    const settledCard = thread("settled", "Card: Settled continuation", {
      shelf: "settled",
      forkedFrom: { threadId: archivedMaster.id },
    });

    const model = workspace([archivedMaster, archivedParent, activeCard, settledCard]);

    expect(model.activeProjects[0]?.masters[0]).toMatchObject({
      master: archivedMaster,
      cards: [activeCard],
    });
    expect(model.activeProjects[0]?.visibleCount).toBe(1);
    expect(model.settledProjects[0]?.masters[0]?.cards).toEqual([settledCard]);
    expect(model.activeProjects.flatMap((group) => group.orphanCards)).toEqual([]);
  });
});

describe("exclusive shelves", () => {
  it("moves a pinned Master and its active Cards to Pinned, so nothing renders twice", () => {
    const master = thread("master", "Master: Harvest", { shelf: "pinned" });
    const card = thread("card", "Card: Prune", { forkedFrom: { threadId: master.id } });
    const snoozedCard = thread("snoozed", "Card: Later", {
      shelf: "snoozed",
      forkedFrom: { threadId: master.id },
    });
    const pinnedCard = thread("pinned-card", "Card: Watch", {
      shelf: "pinned",
      forkedFrom: { threadId: master.id },
    });

    const model = workspace([master, card, snoozedCard, pinnedCard], ["orchard"]);

    expect(model.pinned).toEqual([
      { thread: master, cards: [card] },
      { thread: pinnedCard, cards: [] },
    ]);
    expect(model.activeProjects).toEqual([]);
    // A parked Card stays on its own shelf under an inert structural header,
    // so the pinned Master is navigable exactly once.
    const snoozedGroup = model.snoozedProjects[0];
    expect(snoozedGroup?.masters[0]).toEqual({ master, cards: [snoozedCard], structural: true });
    expect(snoozedGroup ? navigableRows(snoozedGroup) : []).toEqual([snoozedCard]);
  });

  it("never offers an archived Master as a navigable row, only its live Cards", () => {
    const archivedMaster = thread("master", "Master: Archived", { archivedAt: ARCHIVED });
    const card = thread("card", "Card: Still running", {
      forkedFrom: { threadId: archivedMaster.id },
    });
    const chat = thread("chat", "Quick question");

    const group = workspace([archivedMaster, card, chat]).activeProjects[0];

    expect(group?.masters[0]).toMatchObject({ master: archivedMaster, structural: true });
    expect(group ? navigableRows(group) : []).toEqual([card, chat]);
  });
});

describe("nextUnparkedKey", () => {
  it("moves to the next unparked row after parking the open thread, wrapping around", () => {
    const parked = new Set(["b", "d"]);
    const isParked = (key: string) => parked.has(key);

    expect(nextUnparkedKey(["a", "b", "c", "d"], "a", isParked)).toBe("c");
    expect(nextUnparkedKey(["a", "b", "c", "d"], "c", isParked)).toBe("a");
    expect(nextUnparkedKey(["a", "b"], "a", isParked)).toBeNull();
    // Off screen: no guess, the caller starts a new thread instead.
    expect(nextUnparkedKey(["a", "b"], "z", isParked)).toBeNull();
  });
});

describe("sidebar and board agreement", () => {
  it("both place a live Card under its archived Master", () => {
    const archivedMaster = thread("master", "Master: Archived", { archivedAt: ARCHIVED });
    const card = thread("card", "Card: Still running", {
      forkedFrom: { threadId: archivedMaster.id },
    });
    const threads = [archivedMaster, card];

    const sidebarOwner = workspace(threads).activeProjects[0]?.masters[0]?.master;
    const board = deriveMasterBoard(card, threads);

    expect(sidebarOwner).toBe(archivedMaster);
    expect(board?.master).toBe(archivedMaster);
    expect(board?.cards).toEqual([card]);
  });

  it("both resolve a Card living in another project or worktree", () => {
    const master = thread("master", "Master: Harvest", { projectId: "orchard" });
    const card = thread("card", "Card: Elsewhere", {
      projectId: "orchard-worktree",
      forkedFrom: { threadId: master.id },
    });
    const threads = [master, card];

    expect(workspace(threads).activeProjects[0]?.masters[0]?.cards).toEqual([card]);
    expect(deriveMasterBoard(master, threads)?.cards).toEqual([card]);
    expect(deriveMasterBoard(card, threads)?.master).toBe(master);
  });
});

describe("mergeLiveAndArchivedThreads", () => {
  it("lets a live row win over a stale archived record, so unarchiving never hides a Card", () => {
    const master = thread("master", "Master: Harvest");
    const liveCard = thread("card", "Card: Unarchived", { forkedFrom: { threadId: master.id } });
    const staleArchivedCard = { ...liveCard, archivedAt: ARCHIVED };
    const archivedOnly = thread("gone", "Card: Archived", {
      archivedAt: ARCHIVED,
      forkedFrom: { threadId: master.id },
    });

    const merged = mergeLiveAndArchivedThreads(
      [master, liveCard],
      [staleArchivedCard, archivedOnly],
    );

    expect(merged).toEqual([master, liveCard, archivedOnly]);
    expect(deriveMasterBoard(master, merged)?.cards).toEqual([liveCard]);
  });
});

describe("deriveMasterBoard", () => {
  it("recognises Master and Card prefixes without depending on casing or spacing", () => {
    expect(isMasterThreadTitle(" Master: Harvest")).toBe(true);
    expect(isMasterThreadTitle("master : Harvest")).toBe(true);
    expect(isCardThreadTitle("CARD: Prune")).toBe(true);
    expect(isCardThreadTitle("Harvest planning")).toBe(false);
  });

  it("associates cards through direct and nested fork lineage", () => {
    const master = thread("master", "Master: Harvest");
    const direct = thread("direct", "Card: Direct", { forkedFrom: { threadId: master.id } });
    const nested = thread("nested", "Card: Nested", { forkedFrom: { threadId: direct.id } });

    expect(deriveMasterBoard(master, [master, direct, nested])?.cards).toEqual([direct, nested]);
  });

  it("never guesses ownership for unlinked Cards", () => {
    const harvest = thread("harvest", "Master: Harvest");
    const planting = thread("planting", "Master: Planting");
    const linked = thread("linked", "Card: Linked", { forkedFrom: { threadId: harvest.id } });
    const unlinked = thread("unlinked", "Card: Unlinked");

    const board = deriveMasterBoard(harvest, [harvest, planting, linked, unlinked]);

    expect(board?.cards).toEqual([linked]);
    expect(board?.peerMasters).toEqual([planting]);
  });

  it("assigns cards to their nearest Master ancestor", () => {
    const harvest = thread("harvest", "Master: Harvest");
    const planting = thread("planting", "Master: Planting", {
      forkedFrom: { threadId: harvest.id },
    });
    const card = thread("card", "Card: Seed check", { forkedFrom: { threadId: planting.id } });

    expect(deriveMasterBoard(harvest, [harvest, planting, card])?.cards).toEqual([]);
    expect(deriveMasterBoard(planting, [harvest, planting, card])?.cards).toEqual([card]);
  });

  it("excludes archived cards but retains their lineage for a live descendant", () => {
    const master = thread("master", "Master: Harvest");
    const archivedParent = thread("archived-parent", "Card: Archived parent", {
      forkedFrom: { threadId: master.id },
      archivedAt: ARCHIVED,
    });
    const liveChild = thread("live-child", "Card: Live child", {
      forkedFrom: { threadId: archivedParent.id },
    });

    expect(deriveMasterBoard(master, [master, archivedParent, liveChild])?.cards).toEqual([
      liveChild,
    ]);
  });

  it("keeps archived peer Masters hidden while resolving an archived owner", () => {
    const archivedOwner = thread("archived-owner", "Master: Archived owner", {
      archivedAt: ARCHIVED,
    });
    const archivedPeer = thread("archived-peer", "Master: Archived peer", {
      archivedAt: ARCHIVED,
    });
    const livePeer = thread("live-peer", "Master: Live peer");
    const card = thread("card", "Card: Continue", { forkedFrom: { threadId: archivedOwner.id } });

    const board = deriveMasterBoard(card, [archivedOwner, archivedPeer, livePeer, card]);

    expect(board?.master).toBe(archivedOwner);
    expect(board?.peerMasters).toEqual([livePeer]);
  });

  it("ignores broken lineage and cycles, and sorts malformed timestamps consistently", () => {
    const master = thread("master", "Master: Harvest");
    const broken = thread("broken", "Card: Missing parent", {
      forkedFrom: { threadId: "missing" },
    });
    const cycleA = thread("cycle-a", "Card: Cycle A", { forkedFrom: { threadId: "cycle-b" } });
    const cycleB = thread("cycle-b", "Card: Cycle B", { forkedFrom: { threadId: "cycle-a" } });
    const alpha = thread("alpha", "Card: Alpha", {
      forkedFrom: { threadId: master.id },
      updatedAt: "not-a-date",
    });
    const zulu = thread("zulu", "Card: Zulu", {
      forkedFrom: { threadId: master.id },
      updatedAt: "not-a-date",
    });

    expect(deriveMasterBoard(master, [master, broken, cycleA, cycleB, zulu, alpha])?.cards).toEqual(
      [alpha, zulu],
    );
  });

  it("isolates environments", () => {
    const master = thread("master", "Master: Harvest");
    const otherEnvironment = thread("other", "Card: Other environment", {
      environmentId: "env-b",
      forkedFrom: { threadId: master.id },
    });

    expect(deriveMasterBoard(master, [master, otherEnvironment])?.cards).toEqual([]);
  });

  it("returns no board for an ordinary thread", () => {
    const ordinary = thread("ordinary", "Fix the gate");
    expect(deriveMasterBoard(ordinary, [ordinary])).toBeNull();
  });
});
