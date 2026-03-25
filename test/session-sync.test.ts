import { describe, expect, test } from "bun:test";

import { SessionSyncController } from "../public/session-sync";

describe("SessionSyncController", () => {
  test("drains a queued follow-up sync after the current sync completes", async () => {
    const calls: string[] = [];
    let releaseFirstStateLoad: (() => void) | null = null;
    let stateLoads = 0;

    const firstStateLoad = new Promise<void>((resolve) => {
      releaseFirstStateLoad = resolve;
    });

    const controller = new SessionSyncController({
      getHasCurrentSession() {
        return true;
      },
      getIsDocumentHidden() {
        return false;
      },
      async loadSessions() {
        calls.push("load-sessions");
      },
      async loadSessionState() {
        stateLoads += 1;
        calls.push(`load-state:${stateLoads}:start`);

        if (stateLoads === 1) {
          await firstStateLoad;
        }

        calls.push(`load-state:${stateLoads}:end`);
      },
      async refreshSessionListIfStale() {
        calls.push("refresh-session-list");
      },
      scheduleForceResize() {
        calls.push("force-resize");
      },
      reportError(error: unknown) {
        throw error;
      }
    });

    const runPromise = controller.run();
    controller.request({ refreshSessions: true, forceResize: true });
    expect(releaseFirstStateLoad).not.toBeNull();
    releaseFirstStateLoad!();
    await runPromise;

    expect(calls).toEqual([
      "load-state:1:start",
      "load-state:1:end",
      "refresh-session-list",
      "load-sessions",
      "load-state:2:start",
      "load-state:2:end",
      "force-resize"
    ]);
  });
});
