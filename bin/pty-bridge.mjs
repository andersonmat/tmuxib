#!/usr/bin/env node

import { spawn } from "node-pty";

const [, , binary, rawArgs, cwd] = process.argv;

if (!binary || !rawArgs || !cwd) {
  send({
    type: "error",
    message: "pty bridge requires <binary> <json-args> <cwd>"
  });
  process.exit(1);
}

const args = JSON.parse(rawArgs);

const pty = spawn(binary, args, {
  name: "xterm-256color",
  cols: 120,
  rows: 32,
  cwd,
  env: {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "remote-terminal"
  }
});

pty.onData((data) => {
  send({ type: "data", data });
});

pty.onExit(({ exitCode, signal }) => {
  send({ type: "exit", exitCode, signal });
  process.exit(0);
});

process.stdin.setEncoding("utf8");

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;

  while (true) {
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (!line) {
      continue;
    }

    try {
      const message = JSON.parse(line);

      if (message.type === "input" && typeof message.data === "string") {
        pty.write(message.data);
      }

      if (message.type === "resize") {
        const cols = Number.isFinite(message.cols) && message.cols > 0 ? Math.floor(message.cols) : 80;
        const rows = Number.isFinite(message.rows) && message.rows > 0 ? Math.floor(message.rows) : 24;
        pty.resize(cols, rows);
      }
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : "invalid bridge message"
      });
    }
  }
});

process.on("SIGINT", () => {
  pty.kill();
  process.exit(0);
});

process.on("SIGTERM", () => {
  pty.kill();
  process.exit(0);
});

send({ type: "ready" });

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
