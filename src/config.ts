import { resolve } from "node:path";

function readPort(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: readPort(process.env.PORT, 3000),
  nodeBinary: process.env.NODE_BIN ?? "node",
  defaultShell: process.env.DEFAULT_SHELL ?? process.env.SHELL ?? "/bin/bash",
  defaultCwd: resolve(process.env.DEFAULT_CWD ?? process.cwd()),
  tmuxBinary: process.env.TMUX_BIN ?? "tmux",
  sessionPrefix: process.env.SESSION_PREFIX ?? "tmuxib"
} as const;
