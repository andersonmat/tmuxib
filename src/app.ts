import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext, WSMessageReceive } from "hono/ws";

import { config } from "./config";
import { getRuntimeIdentity } from "./runtime";
import { normalizeSessionName } from "./session-name";
import { parseTmuxControlNotification } from "./tmux-control";
import { TmuxService } from "./tmux";
import { createBridgeProcessSpec, resolveBridgeSpawnCwd } from "./pty-bridge";

interface TerminalSocketData {
  clientId: string;
  sessionName: string;
  cwd: string;
  lastResizeCols: number | null;
  lastResizeRows: number | null;
}

interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

interface InputMessage {
  type: "input";
  data: string;
}

interface BridgePayload {
  type: "ready" | "data" | "exit" | "error";
  data?: string;
  exitCode?: number;
  signal?: number;
  message?: string;
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

const runtimeIdentity = getRuntimeIdentity(config.defaultShell, config.defaultCwd);
const tmux = new TmuxService({
  binary: config.tmuxBinary,
  defaultShell: config.defaultShell,
  defaultCwd: config.defaultCwd,
  sessionPrefix: config.sessionPrefix
});
const debugEnabled = process.env.DEBUG_TMUXIB === "1";
const runtimeRoot = resolve(import.meta.dir, "..");
const terminalBridges = new Map<string, TerminalBridge>();
const controlMonitors = new Map<string, TmuxControlMonitor>();

const api = new Hono();
const sessions = new Hono();

sessions.get("/", async (c) => {
  const listedSessions = await tmux.listSessions();
  return c.json({ sessions: listedSessions });
});

sessions.post("/", async (c) => {
  const body = await readJson(c.req.raw);
  const session = await tmux.createSession({
    name: typeof body.name === "string" ? body.name : undefined,
    cwd: resolveCwd(body.cwd)
  });

  return c.json({ session }, 201);
});

sessions.delete("/:sessionName", async (c) => {
  const sessionName = c.req.param("sessionName");

  if (!(await tmux.hasSession(sessionName))) {
    return c.json({ ok: true, sessionExists: false });
  }

  await tmux.killSession(sessionName);
  return c.json({ ok: true, sessionExists: false });
});

sessions.get("/:sessionName/state", async (c) => {
  const sessionName = c.req.param("sessionName");
  const state = await tmux.getSessionState(sessionName);
  return c.json(state);
});

sessions.get("/:sessionName/panes", async (c) => {
  const sessionName = c.req.param("sessionName");
  const panes = await tmux.listPanes(sessionName);
  return c.json({ panes });
});

sessions.post("/:sessionName/panes", async (c) => {
  const sessionName = c.req.param("sessionName");
  const body = await readJson(c.req.raw);

  await tmux.splitPane({
    sessionName,
    targetPane: typeof body.targetPane === "string" ? body.targetPane : undefined,
    direction: body.direction === "horizontal" ? "horizontal" : "vertical",
    cwd: resolveCwd(body.cwd)
  });

  const state = await tmux.getSessionState(sessionName);
  return c.json(state, 201);
});

sessions.post("/:sessionName/windows/:windowIndex/select", async (c) => {
  const sessionName = c.req.param("sessionName");
  const windowIndex = c.req.param("windowIndex");

  await tmux.selectWindow(sessionName, windowIndex);
  const state = await tmux.getSessionState(sessionName);

  return c.json(state);
});

sessions.get("/:sessionName/windows", async (c) => {
  const sessionName = c.req.param("sessionName");
  const windows = await tmux.listWindows(sessionName);
  return c.json({ windows });
});

sessions.post("/:sessionName/panes/:paneId/select", async (c) => {
  const sessionName = c.req.param("sessionName");
  const paneId = c.req.param("paneId");

  await tmux.selectPane(paneId);
  const state = await tmux.getSessionState(sessionName);

  return c.json(state);
});

sessions.delete("/:sessionName/panes/:paneId", async (c) => {
  const sessionName = c.req.param("sessionName");
  const paneId = c.req.param("paneId");

  await tmux.killPane(paneId);
  const sessionExists = await tmux.hasSession(sessionName);

  if (!sessionExists) {
    return c.json({
      sessionExists: false,
      panes: []
    });
  }

  const state = await tmux.getSessionState(sessionName);
  return c.json({
    sessionExists: true,
    ...state
  });
});

api.get("/meta", (c) => {
  return c.json({
    ...runtimeIdentity,
    host: config.host,
    port: config.port
  });
});

api.route("/sessions", sessions);

export const app = new Hono();

app.onError((error, c) => {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  const status = /can't find (session|pane|window)/i.test(message) ? 404 : 500;
  return c.json({ error: message }, status);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.route("/api", api);

app.get(
  "/ws/terminal",
  upgradeWebSocket((c) => {
    return createTerminalSocketEvents({
      requestedSessionName: c.req.query("session") ?? undefined,
      cwd: resolveCwd(c.req.query("cwd"))
    });
  })
);

app.get(
  "/ws/terminal/:sessionName",
  upgradeWebSocket((c) => {
    return createTerminalSocketEvents({
      requestedSessionName: c.req.param("sessionName"),
      cwd: resolveCwd(c.req.query("cwd"))
    });
  })
);

function createTerminalSocketEvents(input: { requestedSessionName: string | undefined; cwd: string }) {
  const socketData: TerminalSocketData = {
    clientId: crypto.randomUUID(),
    sessionName: normalizeSessionName(input.requestedSessionName, config.sessionPrefix),
    cwd: input.cwd,
    lastResizeCols: null,
    lastResizeRows: null
  };

  return {
    onOpen(_event: Event, socket: WSContext) {
      debug("ws open", socketData.sessionName);
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

          if (!cols || !rows) {
            return;
          }

          if (socketData.lastResizeCols === cols && socketData.lastResizeRows === rows) {
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
      debug("ws close", socketData.sessionName);
      cleanupSocket(socketData.clientId);
    }
  };
}

async function attachTmuxClient(socket: WSContext, socketData: TerminalSocketData) {
  try {
    await tmux.ensureSession(socketData.sessionName, socketData.cwd);
    void attachTmuxMonitor(socket, socketData).catch((error) => {
      debug(
        "control monitor failed",
        socketData.sessionName,
        error instanceof Error ? error.message : "unknown error"
      );
    });

    const bridgeProcessSpec = createBridgeProcessSpec(
      config.tmuxBinary,
      tmux.attachArgs(socketData.sessionName),
      socketData.cwd,
      {
        bunMain: Bun.main,
        execPath: process.execPath,
        nodeBinary: config.nodeBinary,
        platform: process.platform
      }
    );
    const bridge = spawnChildProcessBridge(socket, socketData, bridgeProcessSpec);

    terminalBridges.set(socketData.clientId, bridge);
    debug("pty bridge spawned", socketData.sessionName);
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
    config.tmuxBinary,
    tmux.controlArgs(socketData.sessionName),
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
  debug("control monitor spawned", socketData.sessionName);

  monitorProcess.stdin.write("refresh-client -f no-output,ignore-size\n");

  monitorProcess.stdout.on("data", (chunk: string) => {
    monitor.stdoutBuffer = appendChunk(monitor.stdoutBuffer, chunk, (line) => {
      handleTmuxControlLine(socket, socketData, line);
    });
  });

  monitorProcess.stderr.on("data", (chunk: string) => {
    monitor.stderrBuffer = appendChunk(monitor.stderrBuffer, chunk, (line) => {
      debug("control stderr", socketData.sessionName, line);
    });
  });

  monitorProcess.on("exit", (code, signal) => {
    controlMonitors.delete(socketData.clientId);
    debug("control exit", socketData.sessionName, code ?? "none", signal ?? "none");
  });

  monitorProcess.on("error", (error) => {
    controlMonitors.delete(socketData.clientId);
    debug("control error", socketData.sessionName, error.message);
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

function spawnChildProcessBridge(socket: WSContext, socketData: TerminalSocketData, bridgeProcessSpec: ReturnType<typeof createBridgeProcessSpec>) {
  const spawnCwd = resolveBridgeSpawnCwd(runtimeRoot);
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
      debug("bridge stderr", socketData.sessionName, line);
    });
  });

  bridgeProcess.on("exit", (code, signal) => {
    terminalBridges.delete(socketData.clientId);
    debug("bridge exit", socketData.sessionName, code ?? "none", signal ?? "none");
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

async function readJson(request: Request) {
  if (request.headers.get("content-type")?.includes("application/json")) {
    return request.json();
  }

  return {};
}

function resolveCwd(value: unknown) {
  return resolve(typeof value === "string" ? value : config.defaultCwd);
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
      debug("pty ready", socketData.sessionName);
      send(socket, { type: "ready", sessionName: socketData.sessionName });
      return;
    }

    if (payload.type === "data") {
      send(socket, payload);
      return;
    }

    if (payload.type === "exit") {
      debug("pty exit", socketData.sessionName, payload.exitCode ?? "none", payload.signal ?? "none");
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

function handleTmuxControlLine(socket: WSContext, socketData: TerminalSocketData, line: string) {
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

function debug(...parts: Array<string | number>) {
  if (debugEnabled) {
    console.log("[tmuxib]", ...parts);
  }
}
