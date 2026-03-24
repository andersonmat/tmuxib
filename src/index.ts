import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ServerWebSocket } from "bun";

import { config } from "./config";
import { getRuntimeIdentity } from "./runtime";
import { normalizeSessionName } from "./session-name";
import { parseTmuxControlNotification } from "./tmux-control";
import { TmuxService } from "./tmux";

interface TerminalSocketData {
  clientId: string;
  sessionName: string;
  cwd: string;
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
  process: ChildProcessWithoutNullStreams;
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
const debugEnabled = process.env.DEBUG_REMOTE_TERMINAL === "1";
const projectDirectory = process.cwd();
const bridgeScriptPath = resolve(projectDirectory, "bin/pty-bridge.mjs");
const terminalBridges = new Map<string, TerminalBridge>();
const controlMonitors = new Map<string, TmuxControlMonitor>();
const publicRoot = resolve(projectDirectory, "public");
const clientTranspiler = new Bun.Transpiler({
  loader: "ts",
  target: "browser"
});
const vendorFiles = new Map<string, string>([
  ["/vendor/xterm.js", resolve(projectDirectory, "node_modules/@xterm/xterm/lib/xterm.js")],
  ["/vendor/xterm.css", resolve(projectDirectory, "node_modules/@xterm/xterm/css/xterm.css")],
  ["/vendor/xterm-addon-fit.js", resolve(projectDirectory, "node_modules/@xterm/addon-fit/lib/addon-fit.js")]
]);

const server = Bun.serve<TerminalSocketData>({
  hostname: config.host,
  port: config.port,
  async fetch(request, bunServer) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;

      const terminalSocketMatch = pathname.match(/^\/ws\/terminal\/([^/]+)$/);

      if (pathname === "/ws/terminal" || terminalSocketMatch) {
        const clientId = crypto.randomUUID();
        const requestedSessionName = terminalSocketMatch
          ? decodeURIComponent(terminalSocketMatch[1])
          : url.searchParams.get("session") ?? undefined;
        const sessionName = normalizeSessionName(requestedSessionName, config.sessionPrefix);
        const cwd = resolve(url.searchParams.get("cwd") ?? config.defaultCwd);

        if (bunServer.upgrade(request, { data: { clientId, sessionName, cwd } })) {
          return;
        }

        return json({ error: "WebSocket upgrade failed" }, 400);
      }

      if (pathname === "/api/meta") {
        return json({
          ...runtimeIdentity,
          host: config.host,
          port: config.port
        });
      }

      if (pathname === "/api/sessions" && request.method === "GET") {
        const sessions = await tmux.listSessions();
        return json({ sessions });
      }

      if (pathname === "/api/sessions" && request.method === "POST") {
        const body = await readJson(request);
        const session = await tmux.createSession({
          name: typeof body.name === "string" ? body.name : undefined,
          cwd: resolve(typeof body.cwd === "string" ? body.cwd : config.defaultCwd)
        });

        return json({ session }, 201);
      }

      const sessionPanesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/panes$/);
      if (sessionPanesMatch) {
        const sessionName = decodeURIComponent(sessionPanesMatch[1]);

        if (request.method === "GET") {
          const panes = await tmux.listPanes(sessionName);
          return json({ panes });
        }

        if (request.method === "POST") {
          const body = await readJson(request);
          await tmux.splitPane({
            sessionName,
            targetPane: typeof body.targetPane === "string" ? body.targetPane : undefined,
            direction: body.direction === "horizontal" ? "horizontal" : "vertical",
            cwd: resolve(typeof body.cwd === "string" ? body.cwd : config.defaultCwd)
          });

          const { windows, panes } = await tmux.getSessionState(sessionName);
          return json({ windows, panes }, 201);
        }
      }

      const sessionWindowsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/windows$/);
      if (sessionWindowsMatch && request.method === "GET") {
        const sessionName = decodeURIComponent(sessionWindowsMatch[1]);
        const windows = await tmux.listWindows(sessionName);
        return json({ windows });
      }

      const sessionStateMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/state$/);
      if (sessionStateMatch && request.method === "GET") {
        const sessionName = decodeURIComponent(sessionStateMatch[1]);
        const { windows, panes } = await tmux.getSessionState(sessionName);
        return json({ windows, panes });
      }

      const windowSelectMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/windows\/([^/]+)\/select$/);
      if (windowSelectMatch && request.method === "POST") {
        const sessionName = decodeURIComponent(windowSelectMatch[1]);
        const windowIndex = decodeURIComponent(windowSelectMatch[2]);

        await tmux.selectWindow(sessionName, windowIndex);
        const { windows, panes } = await tmux.getSessionState(sessionName);

        return json({ windows, panes });
      }

      const paneSelectMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/panes\/([^/]+)\/select$/);
      if (paneSelectMatch && request.method === "POST") {
        const sessionName = decodeURIComponent(paneSelectMatch[1]);
        const paneId = decodeURIComponent(paneSelectMatch[2]);

        await tmux.selectPane(paneId);
        const { windows, panes } = await tmux.getSessionState(sessionName);
        return json({ windows, panes });
      }

      const paneMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/panes\/([^/]+)$/);
      if (paneMatch && request.method === "DELETE") {
        const sessionName = decodeURIComponent(paneMatch[1]);
        const paneId = decodeURIComponent(paneMatch[2]);

        await tmux.killPane(paneId);
        const sessionExists = await tmux.hasSession(sessionName);

        if (!sessionExists) {
          return json({
            sessionExists: false,
            panes: []
          });
        }

        const { windows, panes } = await tmux.getSessionState(sessionName);

        return json({
          sessionExists: true,
          windows,
          panes
        });
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && request.method === "DELETE") {
        const sessionName = decodeURIComponent(sessionMatch[1]);

        if (!(await tmux.hasSession(sessionName))) {
          return json({ ok: true, sessionExists: false });
        }

        await tmux.killSession(sessionName);
        return json({ ok: true, sessionExists: false });
      }

      if (vendorFiles.has(pathname)) {
        return serveKnownFile(vendorFiles.get(pathname)!);
      }

      if (/^\/s\/[^/]+$/.test(pathname)) {
        return serveKnownFile(resolve(publicRoot, "index.html"));
      }

      const transpiledPath = resolvePublicTranspilePath(pathname);
      if (transpiledPath) {
        return serveTranspiledModule(transpiledPath);
      }

      const filePath = pathname === "/" ? resolve(publicRoot, "index.html") : resolve(publicRoot, `.${pathname}`);
      if (existsSync(filePath)) {
        return serveKnownFile(filePath);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error";
      const status = /can't find (session|pane|window)/i.test(message) ? 404 : 500;
      return json({ error: message }, status);
    }
  },
  websocket: {
    open(websocket) {
      debug("ws open", websocket.data.sessionName);
      void attachTmuxClient(websocket);
    },
    message(websocket, message) {
      const payload = parseMessage(message);
      const bridge = terminalBridges.get(websocket.data.clientId);

      if (!payload || !bridge) {
        return;
      }

      try {
        bridge.process.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        terminalBridges.delete(websocket.data.clientId);
        send(websocket, {
          type: "error",
          message: error instanceof Error ? error.message : "terminal transport failed"
        });
        websocket.close();
      }
    },
    close(websocket) {
      debug("ws close", websocket.data.sessionName);
      const bridge = terminalBridges.get(websocket.data.clientId);
      bridge?.process.kill();
      terminalBridges.delete(websocket.data.clientId);

      const monitor = controlMonitors.get(websocket.data.clientId);
      monitor?.process.kill();
      controlMonitors.delete(websocket.data.clientId);
    }
  }
});

console.log(`remote-terminal listening on http://${server.hostname}:${server.port}`);

async function attachTmuxClient(websocket: ServerWebSocket<TerminalSocketData>) {
  try {
    const { clientId, sessionName, cwd } = websocket.data;
    await tmux.ensureSession(sessionName, cwd);
    void attachTmuxMonitor(websocket).catch((error) => {
      debug("control monitor failed", sessionName, error instanceof Error ? error.message : "unknown error");
    });

    const bridgeProcess = spawnChild(
      config.nodeBinary,
      [bridgeScriptPath, config.tmuxBinary, JSON.stringify(tmux.attachArgs(sessionName)), cwd],
      {
        cwd: projectDirectory,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    bridgeProcess.stdout.setEncoding("utf8");
    bridgeProcess.stderr.setEncoding("utf8");

    const bridge: TerminalBridge = {
      process: bridgeProcess,
      stdoutBuffer: "",
      stderrBuffer: ""
    };

    terminalBridges.set(clientId, bridge);
    debug("pty bridge spawned", sessionName);

    bridgeProcess.stdout.on("data", (chunk: string) => {
      bridge.stdoutBuffer = appendChunk(bridge.stdoutBuffer, chunk, (line) => {
        handleBridgeMessage(websocket, line);
      });
    });

    bridgeProcess.stderr.on("data", (chunk: string) => {
      bridge.stderrBuffer = appendChunk(bridge.stderrBuffer, chunk, (line) => {
        debug("bridge stderr", sessionName, line);
      });
    });

    bridgeProcess.on("exit", (code, signal) => {
      terminalBridges.delete(clientId);
      debug("bridge exit", sessionName, code ?? "none", signal ?? "none");
      websocket.close();
    });

    bridgeProcess.on("error", (error) => {
      terminalBridges.delete(clientId);
      send(websocket, {
        type: "error",
        message: error.message
      });
      websocket.close();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown terminal error";
    send(websocket, { type: "error", message });
    websocket.close();
  }
}

async function attachTmuxMonitor(websocket: ServerWebSocket<TerminalSocketData>) {
  const { clientId, sessionName, cwd } = websocket.data;

  if (controlMonitors.has(clientId)) {
    return;
  }

  const monitorProcess = spawnChild(
    config.tmuxBinary,
    tmux.controlArgs(sessionName),
    {
      cwd,
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

  controlMonitors.set(clientId, monitor);
  debug("control monitor spawned", sessionName);

  monitorProcess.stdin.write("refresh-client -f no-output,ignore-size\n");

  monitorProcess.stdout.on("data", (chunk: string) => {
    monitor.stdoutBuffer = appendChunk(monitor.stdoutBuffer, chunk, (line) => {
      handleTmuxControlLine(websocket, line);
    });
  });

  monitorProcess.stderr.on("data", (chunk: string) => {
    monitor.stderrBuffer = appendChunk(monitor.stderrBuffer, chunk, (line) => {
      debug("control stderr", sessionName, line);
    });
  });

  monitorProcess.on("exit", (code, signal) => {
    controlMonitors.delete(clientId);
    debug("control exit", sessionName, code ?? "none", signal ?? "none");
  });

  monitorProcess.on("error", (error) => {
    controlMonitors.delete(clientId);
    debug("control error", sessionName, error.message);
  });
}

function serveKnownFile(filePath: string) {
  return new Response(Bun.file(filePath));
}

function serveTranspiledModule(filePath: string) {
  const source = Bun.file(filePath).text();
  return source.then((contents) => {
    const transpiled = clientTranspiler.transformSync(contents);

    return new Response(transpiled, {
      headers: {
        "content-type": "application/javascript; charset=utf-8"
      }
    });
  });
}

function resolvePublicTranspilePath(pathname: string) {
  if (pathname.endsWith(".js")) {
    const sourcePath = resolve(publicRoot, `.${pathname.slice(0, -3)}.ts`);
    return existsSync(sourcePath) ? sourcePath : null;
  }

  if (pathname.endsWith(".ts")) {
    const sourcePath = resolve(publicRoot, `.${pathname}`);
    return existsSync(sourcePath) ? sourcePath : null;
  }

  return null;
}

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status });
}

async function readJson(request: Request) {
  if (request.headers.get("content-type")?.includes("application/json")) {
    return request.json();
  }

  return {};
}

function parseMessage(message: string | Buffer | Uint8Array) {
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

function handleBridgeMessage(websocket: ServerWebSocket<TerminalSocketData>, line: string) {
  try {
    const payload = JSON.parse(line) as BridgePayload;

    if (payload.type === "ready") {
      debug("pty ready", websocket.data.sessionName);
      send(websocket, { type: "ready", sessionName: websocket.data.sessionName });
      return;
    }

    if (payload.type === "data") {
      send(websocket, payload);
      return;
    }

    if (payload.type === "exit") {
      debug("pty exit", websocket.data.sessionName, payload.exitCode ?? "none", payload.signal ?? "none");
      send(websocket, payload);
      websocket.close();
      return;
    }

    if (payload.type === "error") {
      send(websocket, payload);
      websocket.close();
    }
  } catch (error) {
    send(websocket, {
      type: "error",
      message: error instanceof Error ? error.message : "invalid bridge payload"
    });
    websocket.close();
  }
}

function handleTmuxControlLine(websocket: ServerWebSocket<TerminalSocketData>, line: string) {
  const payload = parseTmuxControlNotification(line);

  if (!payload) {
    return;
  }

  debug("control notification", websocket.data.sessionName, payload.event);
  send(websocket, payload);
}

function send(websocket: ServerWebSocket<TerminalSocketData>, payload: unknown) {
  try {
    websocket.send(JSON.stringify(payload));
  } catch {
    // The websocket may already be closing; sending is best-effort only.
  }
}

function debug(...parts: Array<string | number>) {
  if (debugEnabled) {
    console.log("[remote-terminal]", ...parts);
  }
}
