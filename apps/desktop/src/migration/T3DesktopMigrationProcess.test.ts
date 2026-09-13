import { assert, describe, it } from "@effect/vitest";

import { containsRunningT3Desktop } from "./T3DesktopMigrationProcess.ts";

describe("containsRunningT3Desktop", () => {
  it("detects the packaged T3 Code main process without matching helpers or Hotlap", () => {
    assert(
      containsRunningT3Desktop(`
/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)
/Applications/T3 Code (Alpha).app/Contents/Frameworks/T3 Code Helper (Renderer).app/Contents/MacOS/T3 Code Helper (Renderer)
      `),
    );
    assert(
      containsRunningT3Desktop(
        "/Users/anish/Applications/T3 Code.app/Contents/MacOS/T3 Code --inspect=0",
      ),
    );
    assert(
      !containsRunningT3Desktop(`
/Applications/Hotlap.app/Contents/MacOS/Hotlap
/Applications/T3 Code.app/Contents/Frameworks/T3 Code Helper.app/Contents/MacOS/T3 Code Helper
      `),
    );
  });
});
