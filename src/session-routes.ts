import { Hono } from "hono";

import { TmuxService } from "./tmux";

interface SessionStatePayload {
  windows: unknown[];
  panes: unknown[];
}

interface CreateSessionsRouterOptions {
  tmux: TmuxService;
  readJson(request: Request): Promise<Record<string, unknown>>;
  resolveCwd(value: unknown): string;
}

export function createSessionsRouter(options: CreateSessionsRouterOptions) {
  const sessions = new Hono();

  sessions.get("/", async (c) => {
    const listedSessions = await options.tmux.listSessions();
    return c.json({ sessions: listedSessions });
  });

  sessions.post("/", async (c) => {
    const body = await options.readJson(c.req.raw);
    const session = await options.tmux.createSession({
      name: typeof body.name === "string" ? body.name : undefined,
      cwd: options.resolveCwd(body.cwd)
    });

    return c.json({ session }, 201);
  });

  sessions.delete("/:sessionName", async (c) => {
    const sessionName = c.req.param("sessionName");

    if (!(await options.tmux.hasSession(sessionName))) {
      return c.json({ ok: true, sessionExists: false });
    }

    await options.tmux.killSession(sessionName);
    return c.json({ ok: true, sessionExists: false });
  });

  sessions.get("/:sessionName/state", async (c) => {
    const sessionName = c.req.param("sessionName");
    const state = await options.tmux.getSessionState(sessionName);
    return c.json(state);
  });

  sessions.get("/:sessionName/panes", async (c) => {
    const sessionName = c.req.param("sessionName");
    const panes = await options.tmux.listPanes(sessionName);
    return c.json({ panes });
  });

  sessions.post("/:sessionName/panes", async (c) => {
    const sessionName = c.req.param("sessionName");
    const body = await options.readJson(c.req.raw);

    await options.tmux.splitPane({
      sessionName,
      targetPane: typeof body.targetPane === "string" ? body.targetPane : undefined,
      direction: body.direction === "horizontal" ? "horizontal" : "vertical",
      cwd: options.resolveCwd(body.cwd)
    });

    const state = await options.tmux.getSessionState(sessionName);
    return c.json(state, 201);
  });

  sessions.post("/:sessionName/windows/:windowIndex/select", async (c) => {
    const sessionName = c.req.param("sessionName");
    const windowIndex = c.req.param("windowIndex");

    await options.tmux.selectWindow(sessionName, windowIndex);
    const state = await options.tmux.getSessionState(sessionName);

    return c.json(state);
  });

  sessions.get("/:sessionName/windows", async (c) => {
    const sessionName = c.req.param("sessionName");
    const windows = await options.tmux.listWindows(sessionName);
    return c.json({ windows });
  });

  sessions.post("/:sessionName/panes/:paneId/select", async (c) => {
    const sessionName = c.req.param("sessionName");
    const paneId = c.req.param("paneId");

    await options.tmux.selectPane(paneId);
    const state = await options.tmux.getSessionState(sessionName);

    return c.json(state);
  });

  sessions.delete("/:sessionName/panes/:paneId", async (c) => {
    const sessionName = c.req.param("sessionName");
    const paneId = c.req.param("paneId");

    await options.tmux.killPane(paneId);
    const sessionExists = await options.tmux.hasSession(sessionName);

    if (!sessionExists) {
      return c.json({
        sessionExists: false,
        panes: []
      });
    }

    const state = await options.tmux.getSessionState(sessionName) as SessionStatePayload;
    return c.json({
      sessionExists: true,
      ...state
    });
  });

  return sessions;
}
