import { assert, it, vi } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

<<<<<<< HEAD
const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);

const makeProject = (scripts: OrchestrationProject["scripts"]): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const makeProjectionSnapshotQueryLayer = (project: OrchestrationProject) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getThreadTranscriptSource: () => Effect.die("unused"),
    getThreadForkSource: () => Effect.die("unused"),
    getPendingForkHandoffSource: () => Effect.die("unused"),
    getUserInputActivity: () => Effect.die("unused"),
    listActivitiesByKind: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getDeletedWorktreeThreads: () => Effect.die("unused"),
    listThreadsWithPullRequests: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getEventReplayStats: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
=======
it.effect("resolves setup scripts through the standalone project service", () => {
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      worktreePath: input.worktreePath ?? null,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Shell",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }),
  );
  const write = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) => Effect.void,
  );
  const listeners: Array<Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]> =
    [];
  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.push(listener);
      return () => undefined;
    });
  const projectId = ProjectId.make("project:setup-runner-v2");
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "vp install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
    ],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
  };
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(TerminalManager.TerminalManager)({ open, write, subscribe }),
        ServerSettings.layerTest(),
>>>>>>> 25d5c7cacb99bc50056edc0ea8d201eac31cfdf4
      ),
    ),
  );

  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
    });
    assert.deepEqual(result, {
      status: "started",
      async: true,
      scriptId: "setup",
      scriptName: "Setup",
      scriptCommand: "vp install",
      terminalId: "setup-setup",
      cwd: "/repo-worktree",
    });
    assert.equal(open.mock.calls[0]?.[0].cwd, "/repo-worktree");
    assert.deepEqual(open.mock.calls[0]?.[0].env, {
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo-worktree",
      COLORTERM: "",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    });
    assert.equal(write.mock.calls[0]?.[0].data, "vp install\r");
    const lines: string[] = [];
    const observed = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      observeCompletion: {
        onOutputLine: (line) =>
          Effect.sync(() => {
            lines.push(line);
          }),
      },
    });
    assert.equal(observed.status, "started");
    const listener = listeners[0]!;
    yield* listener({
      type: "output",
      threadId: "thread-1",
      terminalId: "setup-setup",
      data: "Downloading 10%\rDownloading 20%\r\nDone\n",
    });
    assert.deepEqual(lines, ["Downloading 10%", "Downloading 20%", "Done"]);
    yield* listener({ type: "closed", threadId: "thread-1", terminalId: "setup-setup" });
  }).pipe(Effect.provide(layer));
});
