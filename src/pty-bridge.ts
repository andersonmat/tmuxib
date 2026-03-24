import { resolve } from "node:path";

import { spawn as spawnPty } from "./node-pty";

const bridgeFlag = "--pty-bridge";
const bundledEntrypointPrefix = "/$bunfs/";
const sourceBridgeScriptPath = resolve(import.meta.dir, "..", "bin", "pty-bridge.mjs");

interface InputMessage {
  type: "input";
  data: string;
}

interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

interface BridgeRuntime {
  bunMain: string;
  execPath: string;
  nodeBinary?: string;
}

export interface BridgeProcessSpec {
  command: string;
  args: string[];
}

export function createBridgeProcessSpec(
  binary: string,
  args: string[],
  cwd: string,
  runtime: BridgeRuntime = {
    bunMain: Bun.main,
    execPath: process.execPath,
    nodeBinary: "node"
  }
) {
  const bridgeArgs = [bridgeFlag, binary, JSON.stringify(args), cwd];

  if (isCompiledExecutable(runtime.bunMain)) {
    return {
      command: runtime.execPath,
      args: bridgeArgs
    };
  }

  if (isSourceRuntime(runtime.bunMain)) {
    return {
      command: runtime.nodeBinary ?? "node",
      args: [sourceBridgeScriptPath, binary, JSON.stringify(args), cwd]
    };
  }

  return {
    command: runtime.execPath,
    args: [runtime.bunMain, ...bridgeArgs]
  };
}

export function maybeRunBridgeProcess(argv = process.argv) {
  if (argv[2] !== bridgeFlag) {
    return false;
  }

  const [, , , binary, rawArgs, cwd] = argv;

  if (!binary || !rawArgs || !cwd) {
    send({
      type: "error",
      message: "pty bridge requires <binary> <json-args> <cwd>"
    });
    process.exit(1);
  }

  const args = JSON.parse(rawArgs) as string[];

  const pty = spawnPty(binary, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 32,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "tmuxib"
    }
  });
  let ptyExited = false;

  pty.onData((data) => {
    send({ type: "data", data });
  });

  pty.onExit(({ exitCode, signal }) => {
    ptyExited = true;
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
        const message = JSON.parse(line) as InputMessage | ResizeMessage;

        if (ptyExited) {
          continue;
        }

        if (message.type === "input" && typeof message.data === "string") {
          pty.write(message.data);
        }

        if (message.type === "resize") {
          const cols = Number.isFinite(message.cols) && message.cols > 0 ? Math.floor(message.cols) : 80;
          const rows = Number.isFinite(message.rows) && message.rows > 0 ? Math.floor(message.rows) : 24;
          pty.resize(cols, rows);
        }
      } catch (error) {
        if (isIgnorablePtyError(error)) {
          continue;
        }

        send({
          type: "error",
          message: error instanceof Error ? error.message : "invalid bridge message"
        });
      }
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (!ptyExited) {
        pty.kill();
      }
      process.exit(0);
    });
  }

  send({ type: "ready" });
  return true;
}

function isCompiledExecutable(bunMain: string) {
  return bunMain.startsWith(bundledEntrypointPrefix);
}

function isSourceRuntime(bunMain: string) {
  return bunMain.endsWith(".ts");
}

function send(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function isIgnorablePtyError(error: unknown) {
  return error instanceof Error && /(EBADF|EPIPE|ioctl\(2\) failed)/i.test(error.message);
}
