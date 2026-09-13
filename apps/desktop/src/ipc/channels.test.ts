import { describe, expect, it } from "vite-plus/test";

import * as channels from "./channels.ts";

describe("desktop IPC channels", () => {
  it("does not expose the removed T3 workspace migration", () => {
    const migrationChannels = Object.values(channels).filter((channel) =>
      channel.includes("t3-migration"),
    );

    expect(migrationChannels).toEqual([]);
  });
});
