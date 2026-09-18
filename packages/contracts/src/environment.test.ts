import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("gates provider account routing under server version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.providerAccountRouting).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, providerAccountRouting: true },
      }).capabilities.providerAccountRouting,
    ).toBe(true);
  });

  it("gates custom prompts under server version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.customPrompts).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, customPrompts: true },
      }).capabilities.customPrompts,
    ).toBe(true);
  });

  it("gates transcript export and thread forking under server version skew", () => {
    const legacy = decodeDescriptor(descriptor).capabilities;
    expect(legacy.threadTranscriptExport).toBeUndefined();
    expect(legacy.threadForking).toBeUndefined();
    expect(legacy.threadForkModelSelection).toBeUndefined();

    const current = decodeDescriptor({
      ...descriptor,
      capabilities: {
        ...descriptor.capabilities,
        threadTranscriptExport: true,
        threadForking: true,
        threadForkModelSelection: true,
      },
    }).capabilities;
    expect(current.threadTranscriptExport).toBe(true);
    expect(current.threadForking).toBe(true);
    expect(current.threadForkModelSelection).toBe(true);
  });

  it("requires an advertised required-worktree bootstrap capability", () => {
    expect(decodeDescriptor(descriptor).capabilities.requiredWorktreeBootstrap).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, requiredWorktreeBootstrap: true },
      }).capabilities.requiredWorktreeBootstrap,
    ).toBe(true);
  });

  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("treats a missing attachment upload capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.attachmentUploads).toBeUndefined();
  });

  it("preserves an advertised attachment upload capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, attachmentUploads: true },
      }).capabilities.attachmentUploads,
    ).toBe(true);
  });

  it("preserves the server's generic attachment upload limit", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
        },
      }).capabilities.fileAttachments,
    ).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
  });
});
