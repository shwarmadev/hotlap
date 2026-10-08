import {
  ComposerContextId,
  MessageId,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectReadableThreadMessages,
  type ReadableThreadMessageSource,
  ReadableTranscriptMessageNotFoundError,
  buildForkProviderInput,
  serializeReadableThreadTranscript,
  selectBoundedForkHistory,
} from "./readableThreadTranscript.ts";

type TranscriptMessage = Omit<ReadableThreadMessageSource, "attachments" | "context"> & {
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
};

const message = (
  input: Partial<TranscriptMessage> & Pick<TranscriptMessage, "id" | "role" | "text">,
): TranscriptMessage => ({
  streaming: false,
  createdAt: "2026-09-12T00:00:00.000Z",
  ...input,
});

describe("buildForkProviderInput", () => {
  it("keeps the newest whole history sections and marks omitted older history", () => {
    const result = buildForkProviderInput({
      messages: [
        {
          sourceMessageId: MessageId.make("one"),
          role: "user",
          text: `Old question ${"x".repeat(100)}`,
          createdAt: "x",
        },
        {
          sourceMessageId: MessageId.make("two"),
          role: "assistant",
          text: "Old answer",
          createdAt: "x",
        },
        {
          sourceMessageId: MessageId.make("three"),
          role: "user",
          text: "Selected question",
          createdAt: "x",
        },
        {
          sourceMessageId: MessageId.make("four"),
          role: "assistant",
          text: "Selected answer",
          createdAt: "x",
        },
      ],
      continuation: "Continue here",
      maxChars: 330,
    });

    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.omittedMessageCount).toBe(2);
    expect(result.text).toContain(
      "[Older inherited messages omitted to fit the provider context.]\n\n",
    );
    expect(result.text).toContain("## User\n\nSelected question");
    expect(result.text).toContain("## Assistant\n\nSelected answer");
    expect(result.text).not.toContain("Old question");
    expect(result.text.endsWith("## New user message\n\nContinue here")).toBe(true);
  });

  it("does not split the selected user and assistant turn", () => {
    expect(
      buildForkProviderInput({
        messages: [
          {
            sourceMessageId: MessageId.make("question"),
            role: "user",
            text: "x".repeat(100),
            createdAt: "x",
          },
          {
            sourceMessageId: MessageId.make("answer"),
            role: "assistant",
            text: "short answer",
            createdAt: "x",
          },
        ],
        continuation: "continue",
        maxChars: 180,
      }),
    ).toBeNull();
  });

  it("returns null when the selected response and continuation cannot both fit", () => {
    expect(
      buildForkProviderInput({
        messages: [
          {
            sourceMessageId: MessageId.make("selected"),
            role: "assistant",
            text: "x".repeat(100),
            createdAt: "x",
          },
        ],
        continuation: "continue",
        maxChars: 80,
      }),
    ).toBeNull();
  });
});

describe("selectBoundedForkHistory", () => {
  it.each([399, 400, 401, 1_000, 5_000])(
    "bounds a %i-message history without splitting its oldest retained turn",
    (messageCount) => {
      const pairOffset = messageCount % 2;
      const messages = Array.from({ length: messageCount }, (_, index) => ({
        sourceMessageId: MessageId.make(`message-${index}`),
        role:
          index < pairOffset || (index - pairOffset) % 2 === 0
            ? ("user" as const)
            : ("assistant" as const),
        text: `Message ${index}`,
        createdAt: "x",
      }));

      const result = selectBoundedForkHistory({
        messages,
        maxMessages: 400,
        maxBytes: 4 * 1024 * 1024,
      });

      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.messages.length).toBeLessThanOrEqual(400);
      expect(result.messages[0]?.role).toBe("user");
      expect(result.messages.at(-1)?.sourceMessageId).toBe(`message-${messageCount - 1}`);
      expect(result.omittedMessageCount + result.messages.length).toBe(messageCount);
    },
  );

  it("keeps the newest complete turns when a long conversation exceeds the message cap", () => {
    const messages = Array.from({ length: 500 }, (_, index) => [
      {
        sourceMessageId: MessageId.make(`user-${index}`),
        role: "user" as const,
        text: `Question ${index}`,
        createdAt: "x",
      },
      {
        sourceMessageId: MessageId.make(`assistant-${index}`),
        role: "assistant" as const,
        text: `Answer ${index}`,
        createdAt: "x",
      },
    ]).flat();

    const result = selectBoundedForkHistory({
      messages,
      maxMessages: 400,
      maxBytes: 4 * 1024 * 1024,
    });

    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.omittedMessageCount).toBe(600);
    expect(result.messages).toHaveLength(400);
    expect(result.messages[0]?.sourceMessageId).toBe("user-300");
    expect(result.messages.at(-1)?.sourceMessageId).toBe("assistant-499");
  });

  it("drops whole old turns to satisfy the UTF-8 byte cap", () => {
    const result = selectBoundedForkHistory({
      messages: [
        {
          sourceMessageId: MessageId.make("old-user"),
          role: "user",
          text: "😀".repeat(20),
          createdAt: "x",
        },
        {
          sourceMessageId: MessageId.make("old-assistant"),
          role: "assistant",
          text: "old",
          createdAt: "x",
        },
        {
          sourceMessageId: MessageId.make("selected-user"),
          role: "user",
          text: "new",
          createdAt: "x",
        },
        {
          sourceMessageId: MessageId.make("selected-assistant"),
          role: "assistant",
          text: "answer",
          createdAt: "x",
        },
      ],
      maxMessages: 10,
      maxBytes: 280,
    });

    expect(result).toEqual({
      messages: expect.arrayContaining([
        expect.objectContaining({ sourceMessageId: "selected-user" }),
        expect.objectContaining({ sourceMessageId: "selected-assistant" }),
      ]),
      omittedMessageCount: 2,
    });
    expect(result?.messages).toHaveLength(2);
  });

  it("rejects when the selected turn alone exceeds the safety budget", () => {
    expect(
      selectBoundedForkHistory({
        messages: [
          {
            sourceMessageId: MessageId.make("selected-user"),
            role: "user",
            text: "x".repeat(100),
            createdAt: "x",
          },
          {
            sourceMessageId: MessageId.make("selected-assistant"),
            role: "assistant",
            text: "answer",
            createdAt: "x",
          },
        ],
        maxMessages: 10,
        maxBytes: 200,
      }),
    ).toBeNull();
  });
});

describe("serializeReadableThreadTranscript", () => {
  it("serializes only readable chat roles and expands citations and context labels", () => {
    const contextId = ComposerContextId.make("file-1");
    const result = serializeReadableThreadTranscript([
      message({ id: MessageId.make("system"), role: "system", text: "hidden setup" }),
      message({
        id: MessageId.make("user"),
        role: "user",
        text: "Review [config](t3-context://v1/file/file-1)",
        attachments: [
          {
            type: "file",
            id: "attachment-1",
            name: "settings.json",
            mimeType: "application/json",
            sizeBytes: 42,
          },
        ],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId,
              kind: "file",
              label: "config",
              attachmentId: "attachment-1",
              name: "settings.json",
              mimeType: "application/json",
              sizeBytes: 42,
            },
          ],
        },
      }),
      message({
        id: MessageId.make("assistant"),
        role: "assistant",
        text: "Done",
      }),
    ]);

    expect(result).toEqual({
      markdown:
        "## User\n\nReview [File: config]\n\nAttachments: settings.json\n\n## Assistant\n\nDone",
      messageCount: 2,
    });
  });

  it("marks a streaming assistant response and preserves an attachment-only user message", () => {
    const result = serializeReadableThreadTranscript([
      message({
        id: MessageId.make("user"),
        role: "user",
        text: "",
        attachments: [
          {
            type: "image",
            id: "image-1",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 42,
          },
        ],
      }),
      message({
        id: MessageId.make("assistant"),
        role: "assistant",
        text: "Working on it",
        streaming: true,
      }),
    ]);

    expect(result.markdown).toBe(
      "## User\n\nAttachments: screen.png\n\n## Assistant\n\nWorking on it\n\n_(response in progress)_",
    );
    expect(result.messageCount).toBe(2);
  });

  it("does not repeat an attachment name already represented by an inline context label", () => {
    const contextId = ComposerContextId.make("file-inline");
    const result = serializeReadableThreadTranscript([
      message({
        id: MessageId.make("user-inline-file"),
        role: "user",
        text: "Review [settings.json](t3-context://v1/file/file-inline)",
        attachments: [
          {
            type: "file",
            id: "attachment-inline",
            name: "settings.json",
            mimeType: "application/json",
            sizeBytes: 42,
          },
        ],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId,
              kind: "file",
              label: "settings.json",
              attachmentId: "attachment-inline",
              name: "settings.json",
              mimeType: "application/json",
              sizeBytes: 42,
            },
          ],
        },
      }),
    ]);

    expect(result.markdown).toBe("## User\n\nReview [File: settings.json]");
  });

  it("stops inclusively at the selected response", () => {
    const throughMessageId = MessageId.make("assistant-1");
    const result = serializeReadableThreadTranscript(
      [
        message({ id: MessageId.make("user-1"), role: "user", text: "First" }),
        message({ id: throughMessageId, role: "assistant", text: "Answer" }),
        message({ id: MessageId.make("user-2"), role: "user", text: "Later" }),
      ],
      { throughMessageId },
    );

    expect(result.markdown).toBe("## User\n\nFirst\n\n## Assistant\n\nAnswer");
    expect(result.messageCount).toBe(2);
  });

  it("rejects an unknown inclusive endpoint instead of silently returning a partial transcript", () => {
    expect(() =>
      serializeReadableThreadTranscript(
        [message({ id: MessageId.make("user"), role: "user", text: "Hello" })],
        { throughMessageId: MessageId.make("missing") },
      ),
    ).toThrow(ReadableTranscriptMessageNotFoundError);
  });
});

describe("synthetic usage-limit continuations", () => {
  it("excludes server retry prompts from transcript export and portable fork history", () => {
    const messages = [
      message({ id: MessageId.make("real-request"), role: "user", text: "Fix the bug" }),
      message({
        id: MessageId.make("hotlap-limit-resume:thread:retry"),
        role: "user",
        text: "Continue where you left off.",
      }),
      message({ id: MessageId.make("retry-output"), role: "assistant", text: "Bug fixed" }),
      message({
        id: MessageId.make("manual-continue"),
        role: "user",
        text: "Continue where you left off.",
      }),
    ];
    const transcript = serializeReadableThreadTranscript(messages);
    expect(transcript.messageCount).toBe(3);
    expect(transcript.markdown.match(/Continue where you left off\./g)).toHaveLength(1);
    const history = projectReadableThreadMessages(messages, {
      throughMessageId: MessageId.make("retry-output"),
    });
    expect(history.map((message) => message.text)).toEqual(["Fix the bug", "Bug fixed"]);
  });
});
