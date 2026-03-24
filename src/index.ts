import clientApp from "../public/index.html";
import { websocket } from "hono/bun";

import { app } from "./app";
import { config } from "./config";
import { maybeRunBridgeProcess } from "./pty-bridge";

if (!maybeRunBridgeProcess()) {
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    routes: {
      "/": clientApp,
      "/s/:sessionName": clientApp
    },
    fetch(request, server) {
      return app.fetch(request, { server });
    },
    websocket
  });

  console.log(`tmuxib listening on http://${server.hostname}:${server.port}`);
}
