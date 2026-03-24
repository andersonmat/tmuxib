import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { spawn as spawnPty } from "./node-pty";

const bridgeFlag = "--pty-bridge";
const bundledEntrypointPrefix = "/$bunfs/";
const sourceBridgeScriptPath = resolve(import.meta.dir, "..", "bin", "pty-bridge.mjs");
const activePtys = new Set<object>();
const compiledHelperName = "tmuxib-pty-helper";
let compiledBridgeCommand: string | null = null;

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
  platform?: NodeJS.Platform;
  compiledBridgeCommand?: string;
}

export interface BridgeProcessSpec {
  command: string;
  args: string[];
  spawnMode: "child_process";
}

export function createBridgeProcessSpec(
  binary: string,
  args: string[],
  cwd: string,
  runtime: BridgeRuntime = {
    bunMain: Bun.main,
    execPath: process.execPath,
    nodeBinary: "node",
    platform: process.platform
  }
) {
  const selfBridgeArgs = [bridgeFlag, binary, JSON.stringify(args), cwd];
  const externalBridgeArgs = [binary, JSON.stringify(args), cwd];

  if (isCompiledExecutable(runtime.bunMain)) {
    return {
      command: runtime.compiledBridgeCommand ?? compiledBridgeCommand ?? compiledExecutableCommand(runtime),
      args: externalBridgeArgs,
      spawnMode: "child_process"
    };
  }

  if (isSourceRuntime(runtime.bunMain)) {
    return {
      command: runtime.nodeBinary ?? "node",
      args: [sourceBridgeScriptPath, ...externalBridgeArgs],
      spawnMode: "child_process"
    };
  }

  return {
    command: runtime.execPath,
    args: [runtime.bunMain, ...selfBridgeArgs],
    spawnMode: "child_process"
  };
}

export async function prepareCompiledBridgeHelper() {
  if (!isCompiledExecutable(Bun.main)) {
    return;
  }

  if (compiledBridgeCommand) {
    return;
  }

  const helperBlob = Bun.embeddedFiles.find((blob) => {
    const name = (blob as Blob & { name: string }).name;
    return name === compiledHelperName || name === `${compiledHelperName}.`;
  });

  if (!helperBlob) {
    throw new Error(`Embedded PTY helper "${compiledHelperName}" is missing from the executable`);
  }

  const helperDirectory = join(tmpdir(), "tmuxib");
  const helperAssetName = ((helperBlob as Blob & { name: string }).name || compiledHelperName).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const helperPath = join(helperDirectory, `${process.pid}-${helperAssetName}`);

  await mkdir(helperDirectory, { recursive: true });
  await Bun.write(helperPath, helperBlob);
  await chmod(helperPath, 0o755);

  compiledBridgeCommand = helperPath;
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
  activePtys.add(pty as unknown as object);
  let ptyExited = false;
  // Bun-compiled executables do not reliably stay alive on embedded N-API PTY callbacks alone.
  // Keep the bridge process pinned until the PTY exits or the bridge is explicitly terminated.
  const keepAlive = setInterval(() => {
    // Intentionally empty.
  }, 1000);

  pty.onData((data) => {
    send({ type: "data", data });
  });

  pty.onExit(({ exitCode, signal }) => {
    ptyExited = true;
    activePtys.delete(pty as unknown as object);
    clearInterval(keepAlive);
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
      activePtys.delete(pty as unknown as object);
      clearInterval(keepAlive);
      if (!ptyExited) {
        pty.kill();
      }
      process.exit(0);
    });
  }

  send({ type: "ready" });
  return true;
}

export function resolveBridgeSpawnCwd(preferredCwd: string, fallbackCwd = process.cwd()) {
  return existsSync(preferredCwd) ? preferredCwd : fallbackCwd;
}

function isCompiledExecutable(bunMain: string) {
  return bunMain.startsWith(bundledEntrypointPrefix);
}

function isSourceRuntime(bunMain: string) {
  return bunMain.endsWith(".ts");
}

function compiledExecutableCommand(runtime: BridgeRuntime) {
  return runtime.platform === "linux" ? "/proc/self/exe" : runtime.execPath;
}

function send(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function isIgnorablePtyError(error: unknown) {
  return error instanceof Error && /(EBADF|EPIPE|ioctl\(2\) failed)/i.test(error.message);
}
