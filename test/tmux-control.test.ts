import { describe, expect, test } from "bun:test";

import { parseTmuxControlNotification } from "../src/tmux-control";

describe("parseTmuxControlNotification", () => {
  test("ignores layout-change as a state refresh trigger", () => {
    expect(parseTmuxControlNotification("%layout-change @1 188x44,0,0,0")).toEqual({
      type: "tmux",
      event: "layout-change",
      refreshState: false,
      refreshSessions: false
    });
  });

  test("keeps client-session-changed as a local session hint only", () => {
    expect(parseTmuxControlNotification("%client-session-changed /dev/pts/1 $1 demo")).toEqual({
      type: "tmux",
      event: "client-session-changed",
      sessionName: "demo",
      refreshState: false,
      refreshSessions: false
    });
  });

  test("still refreshes state for real session changes", () => {
    expect(parseTmuxControlNotification("%session-changed $1 demo")).toEqual({
      type: "tmux",
      event: "session-changed",
      sessionName: "demo",
      refreshState: true,
      refreshSessions: true
    });
  });
});
