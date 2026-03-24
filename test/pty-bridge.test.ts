import { describe, expect, test } from "bun:test";

import { createBridgeProcessSpec, resolveBridgeSpawnCwd } from "../src/pty-bridge";

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
      ],
      spawnMode: "child_process"
    });
  });

  test("re-enters the compiled executable directly in bundled mode", () => {
    const spec = createBridgeProcessSpec(
      "tmux",
      ["attach-session", "-t", "demo"],
      "/tmp/demo",
      {
        bunMain: "/$bunfs/root/app",
        execPath: "/tmp/tmuxib",
        platform: "linux"
      }
    );

    expect(spec).toEqual({
      command: "/proc/self/exe",
      args: [
        "--pty-bridge",
        "tmux",
        JSON.stringify(["attach-session", "-t", "demo"]),
        "/tmp/demo"
      ],
      spawnMode: "bun"
    });
  });
});

describe("resolveBridgeSpawnCwd", () => {
  test("uses the preferred cwd when it exists", () => {
    expect(resolveBridgeSpawnCwd("/tmp", "/work/fallback")).toBe("/tmp");
  });

  test("falls back when the preferred cwd is not on the host filesystem", () => {
    expect(resolveBridgeSpawnCwd("/$bunfs/root", "/work/fallback")).toBe("/work/fallback");
  });
});
