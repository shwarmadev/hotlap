import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentSessionImportSource, AgentSessionScanResult } from "./agentSessions.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);
const decodeImportSource = Schema.decodeUnknownSync(AgentSessionImportSource);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });
});

describe("AgentSessionImportSource", () => {
  it("decodes import records written before parser versioning", () => {
    const source = decodeImportSource({
      provider: "codex",
      providerInstanceId: "codex",
      providerSessionId: "session-1",
      filePath: "/tmp/session.jsonl",
      size: 42,
      mtimeMs: 1,
      device: 2,
      inode: 3,
      birthtimeMs: 4,
    });

    expect(source.parserVersion).toBeUndefined();
    expect(source.parserReviewVersion).toBeUndefined();
  });

  it("decodes parser reviews that preserve user-modified imports", () => {
    const source = decodeImportSource({
      provider: "codex",
      providerInstanceId: "codex",
      providerSessionId: "session-1",
      filePath: "/tmp/session.jsonl",
      size: 42,
      mtimeMs: 1,
      device: 2,
      inode: 3,
      birthtimeMs: 4,
      parserReviewVersion: 1,
    });

    expect(source.parserReviewVersion).toBe(1);
    expect(source.parserVersion).toBeUndefined();
  });
});
