import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TmuxService } from "../src/tmux";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function createFakeTmux() {
  const directory = mkdtempSync(join(tmpdir(), "remote-terminal-tmux-"));
  const binary = join(directory, "tmux");
  const stateFile = join(directory, "session.state");
  const logFile = join(directory, "commands.log");

  writeFileSync(
    binary,
    `#!/usr/bin/env bash
set -eu

cmd="$1"
shift || true

printf '%s|%s\n' "$cmd" "$*" >> ${shellQuote(logFile)}

missing_server_error='error connecting to /tmp/tmux-1000/default (No such file or directory)'

case "$cmd" in
  has-session)
    if [ -f ${shellQuote(stateFile)} ]; then
      exit 0
    fi

    printf '%s\n' "$missing_server_error" >&2
    exit 1
    ;;
  list-sessions)
    if [ -f ${shellQuote(stateFile)} ]; then
      printf 'test\\0371\\0370\\037Fri Mar 20 16:10:12 2026\n'
      exit 0
    fi

    printf '%s\n' "$missing_server_error" >&2
    exit 1
    ;;
  new-session)
    touch ${shellQuote(stateFile)}
    exit 0
    ;;
  *)
    printf 'unsupported command: %s\n' "$cmd" >&2
    exit 2
    ;;
esac
`,
    "utf8"
  );

  chmodSync(binary, 0o755);

  return {
    binary,
    directory,
    logFile,
    stateFile
  };
}

function createTmuxService(binary: string) {
  return new TmuxService({
    binary,
    defaultShell: "/bin/bash",
    defaultCwd: "/tmp",
    sessionPrefix: "rt"
  });
}

describe("TmuxService", () => {
  test("treats a missing tmux socket as no active session", async () => {
    const fakeTmux = createFakeTmux();

    try {
      const service = createTmuxService(fakeTmux.binary);
      await expect(service.hasSession("test")).resolves.toBe(false);
      await expect(service.listSessions()).resolves.toEqual([]);
    } finally {
      rmSync(fakeTmux.directory, { force: true, recursive: true });
    }
  });

  test("starts a session when tmux has not created its server socket yet", async () => {
    const fakeTmux = createFakeTmux();

    try {
      const service = createTmuxService(fakeTmux.binary);
      await service.ensureSession("test", "/tmp/project");

      expect(existsSync(fakeTmux.stateFile)).toBe(true);
      expect(readFileSync(fakeTmux.logFile, "utf8").trim().split("\n")).toEqual([
        "has-session|-t test",
        "new-session|-d -s test -c /tmp/project"
      ]);
    } finally {
      rmSync(fakeTmux.directory, { force: true, recursive: true });
    }
  });
});
