import { websocket } from "hono/bun";

import { app } from "./app";
import { config } from "./config";

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch(request, server) {
    return app.fetch(request, { server });
  },
  websocket
});

console.log(`tmuxib listening on http://${server.hostname}:${server.port}`);
