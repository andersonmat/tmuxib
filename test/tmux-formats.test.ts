import { describe, expect, test } from "bun:test";

import { parsePanes, parseSessions, parseWindows } from "../src/tmux-formats";

describe("parseSessions", () => {
  test("parses tmux session rows", () => {
    const output = "rt-dev\u001f2\u001f1\u001fFri Mar 20 16:10:12 2026";
    expect(parseSessions(output)).toEqual([
      {
        name: "rt-dev",
        windows: 2,
        attached: 1,
        created: "Fri Mar 20 16:10:12 2026"
      }
    ]);
  });
});

describe("parsePanes", () => {
  test("parses pane metadata", () => {
    const output =
      "rt-dev\u001f0\u001feditor\u001f1\u001f%4\u001f1\u001fbash\u001f/home/matt/dev/remote-terminal\u001feditor";

    expect(parsePanes(output)).toEqual([
      {
        sessionName: "rt-dev",
        windowIndex: 0,
        windowName: "editor",
        paneIndex: 1,
        id: "%4",
        active: true,
        command: "bash",
        path: "/home/matt/dev/remote-terminal",
        title: "editor"
      }
    ]);
  });
});

describe("parseWindows", () => {
  test("parses window metadata", () => {
    const output = "rt-dev\u001f2\u001flogs\u001f1\u001f3";

    expect(parseWindows(output)).toEqual([
      {
        sessionName: "rt-dev",
        index: 2,
        name: "logs",
        active: true,
        panes: 3
      }
    ]);
  });
});
