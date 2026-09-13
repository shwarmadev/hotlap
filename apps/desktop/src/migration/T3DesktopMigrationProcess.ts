// @effect-diagnostics nodeBuiltinImport:off -- This macOS adapter reads process state without changing it.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import type { T3DesktopProcessProbe } from "./T3DesktopMigrationCore.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const T3_DESKTOP_MAIN_PROCESS =
  /\/T3 Code(?: \([^/]+\))?\.app\/Contents\/MacOS\/T3 Code(?: \([^/]+\))?(?:\s|$)/u;

export function containsRunningT3Desktop(processCommands: string): boolean {
  return processCommands
    .split("\n")
    .some((command) => T3_DESKTOP_MAIN_PROCESS.test(command.trim()));
}

export const macT3DesktopProcessProbe: T3DesktopProcessProbe = {
  isPidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  isT3DesktopRunning: async () => {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "command="]);
    return containsRunningT3Desktop(stdout);
  },
};
