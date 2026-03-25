import { resolve } from "node:path";

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";

import { config } from "./config";
import { getRuntimeIdentity } from "./runtime";
import { createSessionsRouter } from "./session-routes";
import { isMissingTmuxTargetError, TmuxService } from "./tmux";
import { createTerminalSocketManager } from "./terminal-socket";

const runtimeIdentity = getRuntimeIdentity(config.defaultShell, config.defaultCwd);
const tmux = new TmuxService({
  binary: config.tmuxBinary,
  defaultShell: config.defaultShell,
  defaultCwd: config.defaultCwd,
  sessionPrefix: config.sessionPrefix
});
const debugEnabled = process.env.DEBUG_TMUXIB === "1";
const runtimeRoot = resolve(import.meta.dir, "..");
const terminalSocketManager = createTerminalSocketManager({
  tmux,
  tmuxBinary: config.tmuxBinary,
  sessionPrefix: config.sessionPrefix,
  nodeBinary: config.nodeBinary,
  runtimeRoot,
  debugEnabled
});

const api = new Hono();
const sessions = createSessionsRouter({
  tmux,
  readJson,
  resolveCwd
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
  const status = isMissingTmuxTargetError(error) ? 404 : 500;
  return c.json({ error: message }, status);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.route("/api", api);

app.get(
  "/ws/terminal",
  upgradeWebSocket((c) => {
    return terminalSocketManager.createTerminalSocketEvents({
      requestedSessionName: c.req.query("session") ?? undefined,
      cwd: resolveCwd(c.req.query("cwd"))
    });
  })
);

app.get(
  "/ws/terminal/:sessionName",
  upgradeWebSocket((c) => {
    return terminalSocketManager.createTerminalSocketEvents({
      requestedSessionName: c.req.param("sessionName"),
      cwd: resolveCwd(c.req.query("cwd"))
    });
  })
);

async function readJson(request: Request) {
  if (request.headers.get("content-type")?.includes("application/json")) {
    return request.json();
  }

  return {};
}

function resolveCwd(value: unknown) {
  return resolve(typeof value === "string" ? value : config.defaultCwd);
}
