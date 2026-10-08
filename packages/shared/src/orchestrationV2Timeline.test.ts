import { MessageId, NodeId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createOrchestrationV2TurnItemVisibility,
  isOrchestrationV2TurnItemVisible,
} from "./orchestrationV2Timeline.ts";

const runId = RunId.make("run:timeline-visibility");
const nodeId = NodeId.make("node:timeline-visibility");

describe.each([
  ["point", isOrchestrationV2TurnItemVisible],
  [
    "indexed",
    (input: Parameters<typeof isOrchestrationV2TurnItemVisible>[0]) =>
      createOrchestrationV2TurnItemVisibility(input)(input.item),
  ],
] as const)("%s timeline visibility", (_, isVisible) => {
  it("hides synthetic retry prompts but keeps real user text", () => {
    const synthetic = {
      type: "user_message" as const,
      messageId: MessageId.make("hotlap-limit-resume:thread:retry"),
      runId,
      nodeId,
    };
    const runs = [{ id: runId, status: "running" as const, userMessageId: synthetic.messageId }];
    expect(isVisible({ item: synthetic, runs, attempts: [], items: [synthetic] })).toBe(false);
    const real = { ...synthetic, messageId: MessageId.make("manual-continue") };
    expect(isVisible({ item: real, runs, attempts: [], items: [real] })).toBe(true);
  });

  it("hides only usage-limit failures from synthetic retry runs", () => {
    const item = {
      type: "error" as const,
      failure: { class: "usage_limit" as const },
      runId,
      nodeId,
    };
    const runs = [
      {
        id: runId,
        status: "failed" as const,
        userMessageId: MessageId.make("hotlap-limit-resume:thread:retry"),
      },
    ];
    expect(isVisible({ item, runs, attempts: [], items: [item] })).toBe(false);
    expect(
      isVisible({
        item,
        runs: [{ ...runs[0]!, userMessageId: MessageId.make("real-user-message") }],
        attempts: [],
        items: [item],
      }),
    ).toBe(true);
    const transport = { ...item, failure: { class: "transport_error" as const } };
    expect(isVisible({ item: transport, runs, attempts: [], items: [transport] })).toBe(true);
    const assistant = { type: "assistant_message" as const, runId, nodeId };
    expect(isVisible({ item: assistant, runs, attempts: [], items: [assistant] })).toBe(true);
  });

  it("hides unpaired interruption results from superseded attempts", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "running" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "superseded" }],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(false);
  });

  it("keeps paired interruption results from superseded attempts", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "running" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "superseded" }],
        items: [
          { type: "run_interrupt_request", runId, nodeId },
          { type: "run_interrupt_result", runId, nodeId },
        ],
      }),
    ).toBe(true);
  });

  it("keeps interruption results from terminal attempts without a request", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "interrupted" }],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("keeps interruption results from terminal attempts with a request", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "interrupted" }],
        items: [
          { type: "run_interrupt_request", runId, nodeId },
          { type: "run_interrupt_result", runId, nodeId },
        ],
      }),
    ).toBe(true);
  });

  it("hides queued user messages once their run is cancelled", () => {
    expect(
      isVisible({
        item: { type: "user_message", inputIntent: "queued_turn", runId, nodeId },
        runs: [{ id: runId, status: "cancelled" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "queued_turn", runId, nodeId }],
      }),
    ).toBe(false);
  });

  it("keeps queued user messages while their run is queued", () => {
    expect(
      isVisible({
        item: { type: "user_message", inputIntent: "queued_turn", runId, nodeId },
        runs: [{ id: runId, status: "queued" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "queued_turn", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("keeps non-queued user messages on cancelled runs", () => {
    expect(
      isVisible({
        item: { type: "user_message", inputIntent: "turn_start", runId, nodeId },
        runs: [{ id: runId, status: "cancelled" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "turn_start", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("does not hide an interruption because another attempt was superseded", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [
          {
            runId,
            rootNodeId: NodeId.make("node:timeline-visibility:older"),
            status: "superseded",
          },
          { runId, rootNodeId: nodeId, status: "interrupted" },
        ],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(true);
  });
});
