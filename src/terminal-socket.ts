import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { WSContext, WSMessageReceive } from "hono/ws";

import type { BridgePayload, InputMessage, ResizeMessage } from "../shared/terminal-protocol";
import { createBridgeProcessSpec, resolveBridgeSpawnCwd } from "./pty-bridge";
import { normalizeSessionName } from "./session-name";
import { parseTmuxControlNotification } from "./tmux-control";
import { TmuxService } from "./tmux";

interface TerminalSocketData {
  clientId: string;
  sessionName: string;
  cwd: string;
  lastResizeCols: number | null;
  lastResizeRows: number | null;
}

interface TerminalBridge {
  write(input: string): void;
  kill(): void;
  stdoutBuffer: string;
  stderrBuffer: string;
}

interface TmuxControlMonitor {
  process: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  stderrBuffer: string;
}

interface TerminalSocketManagerOptions {
  tmux: TmuxService;
  tmuxBinary: string;
  sessionPrefix: string;
  nodeBinary?: string;
  runtimeRoot: string;
  debugEnabled?: boolean;
}

export function createTerminalSocketManager(options: TerminalSocketManagerOptions) {
  const terminalBridges = new Map<string, TerminalBridge>();
  const controlMonitors = new Map<string, TmuxControlMonitor>();

  return {
    createTerminalSocketEvents(input: { requestedSessionName: string | undefined; cwd: string }) {
      const socketData: TerminalSocketData = {
        clientId: crypto.randomUUID(),
        sessionName: normalizeSessionName(input.requestedSessionName, options.sessionPrefix),
        cwd: input.cwd,
        lastResizeCols: null,
        lastResizeRows: null
      };

      return {
        onOpen(_event: Event, socket: WSContext) {
          debug(options.debugEnabled, "ws open", socketData.sessionName);
          void attachTmuxClient(socket, socketData);
        },
        onMessage(event: MessageEvent<WSMessageReceive>, socket: WSContext) {
          const payload = parseMessage(event.data);
          const bridge = terminalBridges.get(socketData.clientId);

          if (!payload || !bridge) {
            return;
          }

          try {
            if (payload.type === "resize") {
              const cols = Number.isFinite(payload.cols) && payload.cols > 0 ? Math.floor(payload.cols) : null;
              const rows = Number.isFinite(payload.rows) && payload.rows > 0 ? Math.floor(payload.rows) : null;
              const force = payload.force === true;

              if (!cols || !rows) {
                return;
              }

              if (!force && socketData.lastResizeCols === cols && socketData.lastResizeRows === rows) {
                return;
              }

              socketData.lastResizeCols = cols;
              socketData.lastResizeRows = rows;
              bridge.write(`${JSON.stringify({ type: "resize", cols, rows })}\n`);
              return;
            }

            bridge.write(`${JSON.stringify(payload)}\n`);
          } catch (error) {
            cleanupSocket(socketData.clientId);
            send(socket, {
              type: "error",
              message: error instanceof Error ? error.message : "terminal transport failed"
            });
            socket.close();
          }
        },
        onClose() {
          debug(options.debugEnabled, "ws close", socketData.sessionName);
          cleanupSocket(socketData.clientId);
        }
      };
    }
  };

  async function attachTmuxClient(socket: WSContext, socketData: TerminalSocketData) {
    try {
      await options.tmux.ensureSession(socketData.sessionName, socketData.cwd);
      void attachTmuxMonitor(socket, socketData).catch((error) => {
        debug(
          options.debugEnabled,
          "control monitor failed",
          socketData.sessionName,
          error instanceof Error ? error.message : "unknown error"
        );
      });

      const bridgeProcessSpec = createBridgeProcessSpec(
        options.tmuxBinary,
        options.tmux.attachArgs(socketData.sessionName),
        socketData.cwd,
        {
          bunMain: Bun.main,
          execPath: process.execPath,
          nodeBinary: options.nodeBinary,
          platform: process.platform
        }
      );
      const bridge = spawnChildProcessBridge(socket, socketData, bridgeProcessSpec);

      terminalBridges.set(socketData.clientId, bridge);
      debug(options.debugEnabled, "pty bridge spawned", socketData.sessionName);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown terminal error";
      send(socket, { type: "error", message });
      socket.close();
    }
  }

  async function attachTmuxMonitor(socket: WSContext, socketData: TerminalSocketData) {
    if (controlMonitors.has(socketData.clientId)) {
      return;
    }

    const monitorProcess = spawnChild(
      options.tmuxBinary,
      options.tmux.controlArgs(socketData.sessionName),
      {
        cwd: socketData.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    monitorProcess.stdout.setEncoding("utf8");
    monitorProcess.stderr.setEncoding("utf8");

    const monitor: TmuxControlMonitor = {
      process: monitorProcess,
      stdoutBuffer: "",
      stderrBuffer: ""
    };

    controlMonitors.set(socketData.clientId, monitor);
    debug(options.debugEnabled, "control monitor spawned", socketData.sessionName);

    monitorProcess.stdin.write("refresh-client -f no-output,ignore-size\n");

    monitorProcess.stdout.on("data", (chunk: string) => {
      monitor.stdoutBuffer = appendChunk(monitor.stdoutBuffer, chunk, (line) => {
        handleTmuxControlLine(socket, line);
      });
    });

    monitorProcess.stderr.on("data", (chunk: string) => {
      monitor.stderrBuffer = appendChunk(monitor.stderrBuffer, chunk, (line) => {
        debug(options.debugEnabled, "control stderr", socketData.sessionName, line);
      });
    });

    monitorProcess.on("exit", (code, signal) => {
      controlMonitors.delete(socketData.clientId);
      debug(options.debugEnabled, "control exit", socketData.sessionName, code ?? "none", signal ?? "none");
    });

    monitorProcess.on("error", (error) => {
      controlMonitors.delete(socketData.clientId);
      debug(options.debugEnabled, "control error", socketData.sessionName, error.message);
    });
  }

  function cleanupSocket(clientId: string) {
    const bridge = terminalBridges.get(clientId);
    bridge?.kill();
    terminalBridges.delete(clientId);

    const monitor = controlMonitors.get(clientId);
    monitor?.process.kill();
    controlMonitors.delete(clientId);
  }

  function spawnChildProcessBridge(
    socket: WSContext,
    socketData: TerminalSocketData,
    bridgeProcessSpec: ReturnType<typeof createBridgeProcessSpec>
  ) {
    const spawnCwd = resolveBridgeSpawnCwd(options.runtimeRoot);
    const bridgeProcess = spawnChild(
      bridgeProcessSpec.command,
      bridgeProcessSpec.args,
      {
        cwd: spawnCwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    bridgeProcess.stdout.setEncoding("utf8");
    bridgeProcess.stderr.setEncoding("utf8");

    const bridge: TerminalBridge = {
      write(input: string) {
        bridgeProcess.stdin.write(input);
      },
      kill() {
        bridgeProcess.kill();
      },
      stdoutBuffer: "",
      stderrBuffer: ""
    };

    bridgeProcess.stdout.on("data", (chunk: string) => {
      bridge.stdoutBuffer = appendChunk(bridge.stdoutBuffer, chunk, (line) => {
        handleBridgeMessage(socket, socketData, line);
      });
    });

    bridgeProcess.stderr.on("data", (chunk: string) => {
      bridge.stderrBuffer = appendChunk(bridge.stderrBuffer, chunk, (line) => {
        debug(options.debugEnabled, "bridge stderr", socketData.sessionName, line);
      });
    });

    bridgeProcess.on("exit", (code, signal) => {
      terminalBridges.delete(socketData.clientId);
      debug(options.debugEnabled, "bridge exit", socketData.sessionName, code ?? "none", signal ?? "none");
      socket.close();
    });

    bridgeProcess.on("error", (error) => {
      terminalBridges.delete(socketData.clientId);
      send(socket, {
        type: "error",
        message: error.message
      });
      socket.close();
    });

    return bridge;
  }
}

function parseMessage(message: WSMessageReceive) {
  if (message instanceof Blob) {
    return null;
  }

  const raw = typeof message === "string" ? message : Buffer.from(message).toString("utf8");

  try {
    return JSON.parse(raw) as ResizeMessage | InputMessage;
  } catch {
    return null;
  }
}

function appendChunk(buffer: string, chunk: string, onLine: (line: string) => void) {
  let working = buffer + chunk;

  while (true) {
    const newlineIndex = working.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = working.slice(0, newlineIndex).trim();
    working = working.slice(newlineIndex + 1);

    if (line) {
      onLine(line);
    }
  }

  return working;
}

function handleBridgeMessage(socket: WSContext, socketData: TerminalSocketData, line: string) {
  try {
    const payload = JSON.parse(line) as BridgePayload;

    if (payload.type === "ready") {
      send(socket, { type: "ready", sessionName: socketData.sessionName });
      return;
    }

    if (payload.type === "data") {
      send(socket, payload);
      return;
    }

    if (payload.type === "exit") {
      send(socket, payload);
      socket.close();
      return;
    }

    if (payload.type === "error") {
      send(socket, payload);
      socket.close();
    }
  } catch (error) {
    send(socket, {
      type: "error",
      message: error instanceof Error ? error.message : "invalid bridge payload"
    });
    socket.close();
  }
}

function handleTmuxControlLine(socket: WSContext, line: string) {
  const payload = parseTmuxControlNotification(line);

  if (!payload) {
    return;
  }

  send(socket, payload);
}

function send(socket: WSContext, payload: unknown) {
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // The websocket may already be closing; sending is best-effort only.
  }
}

function debug(enabled: boolean | undefined, ...parts: Array<string | number>) {
  if (enabled) {
    console.log("[tmuxib]", ...parts);
  }
}
