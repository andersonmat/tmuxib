import { describe, expect, test } from "bun:test";

import { createBridgeProcessSpec } from "../src/pty-bridge";

describe("createBridgeProcessSpec", () => {
  test("uses the Node bridge script in source mode", () => {
    const spec = createBridgeProcessSpec(
      "tmux",
      ["attach-session", "-t", "demo"],
      "/tmp/demo",
      {
        bunMain: "/workspace/src/index.ts",
        execPath: "/usr/bin/bun",
        nodeBinary: "node"
      }
    );

    expect(spec).toEqual({
      command: "node",
      args: [
        expect.stringContaining("/bin/pty-bridge.mjs"),
        "tmux",
        JSON.stringify(["attach-session", "-t", "demo"]),
        "/tmp/demo"
      ]
    });
  });

  test("re-enters the compiled executable directly in bundled mode", () => {
    const spec = createBridgeProcessSpec(
      "tmux",
      ["attach-session", "-t", "demo"],
      "/tmp/demo",
      {
        bunMain: "/$bunfs/root/app",
        execPath: "/tmp/tmuxib"
      }
    );

    expect(spec).toEqual({
      command: "/tmp/tmuxib",
      args: [
        "--pty-bridge",
        "tmux",
        JSON.stringify(["attach-session", "-t", "demo"]),
        "/tmp/demo"
      ]
    });
  });
});
