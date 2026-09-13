import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopT3MigrationInspectionSchema,
  DesktopT3MigrationStartInputSchema,
  DesktopT3MigrationStartResultSchema,
} from "./ipc.ts";

const decodeDesktopT3MigrationInspection = Schema.decodeSync(DesktopT3MigrationInspectionSchema);
const decodeUnknownDesktopT3MigrationInspection = Schema.decodeUnknownSync(
  DesktopT3MigrationInspectionSchema,
);
const decodeDesktopT3MigrationStartInput = Schema.decodeSync(DesktopT3MigrationStartInputSchema);
const decodeDesktopT3MigrationStartResult = Schema.decodeSync(DesktopT3MigrationStartResultSchema);

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("desktop T3 migration schemas", () => {
  it("decodes an eligible migration with the source summary", () => {
    expect(
      decodeDesktopT3MigrationInspection({
        status: "ready",
        dismissed: false,
        summary: {
          projectCount: 9,
          threadCount: 184,
          destinationHasData: true,
          pairingTransfer: "re-pair-required",
        },
      }),
    ).toEqual({
      status: "ready",
      dismissed: false,
      summary: {
        projectCount: 9,
        threadCount: 184,
        destinationHasData: true,
        pairingTransfer: "re-pair-required",
      },
    });
  });

  it("keeps blocked reasons exhaustive and separate from unexpected failures", () => {
    expect(
      decodeDesktopT3MigrationInspection({
        status: "blocked",
        reason: "source-running",
        dismissed: false,
        summary: {
          projectCount: 9,
          threadCount: 184,
          destinationHasData: false,
          pairingTransfer: "preserved",
        },
      }).status,
    ).toBe("blocked");
    expect(() =>
      decodeUnknownDesktopT3MigrationInspection({
        status: "blocked",
        reason: "something-went-wrong",
        dismissed: false,
        summary: {
          projectCount: 0,
          threadCount: 0,
          destinationHasData: false,
          pairingTransfer: "preserved",
        },
      }),
    ).toThrow();
  });

  it("decodes explicit replacement intent and completion state", () => {
    expect(decodeDesktopT3MigrationStartInput({ replaceExisting: true })).toEqual({
      replaceExisting: true,
    });
    expect(
      decodeDesktopT3MigrationStartResult({
        status: "completed",
        pairingTransfer: "preserved",
      }),
    ).toEqual({
      status: "completed",
      pairingTransfer: "preserved",
    });

    expect(
      decodeDesktopT3MigrationStartResult({
        status: "error",
        message: "Hotlap could not prepare the switch. Your T3 Code data was not changed.",
      }),
    ).toEqual({
      status: "error",
      message: "Hotlap could not prepare the switch. Your T3 Code data was not changed.",
    });
  });
});
