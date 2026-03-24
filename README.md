# Remote Terminal

`remote-terminal` is a Bun-based scaffold for serving a real `tmux` session through the browser. The server runs all shells and `tmux` clients as the same user/group as the server process, exposes a small HTTP control plane for sessions and panes, and streams the live terminal UI over WebSocket into `xterm.js`.

## What this scaffold already does

- Starts a Bun HTTP/WebSocket server with no framework overhead.
- Creates and reuses `tmux` sessions on demand.
- Attaches a browser client to the real `tmux` UI through a PTY, not a mock shell.
- Lists sessions, windows, and panes through JSON APIs.
- Splits panes, focuses panes, kills panes, and kills sessions through explicit `tmux` commands.
- Pushes session/window updates quickly through a tmux control-mode monitor.

## Requirements

- Bun `1.3+`
- Node.js `22+`
- `tmux` `3.2+`
- A POSIX shell such as `/bin/bash` or `/bin/zsh`
- Build tools needed by `node-pty` on your machine

## Run it

```bash
bun install
bun run dev
```

The server binds to `127.0.0.1:3000` by default.

## Scripts

```bash
bun run dev
bun run start
bun run build
bun run check
bun run test
```

## Environment

Copy `.env.example` if you want to override defaults.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `3000` | HTTP/WebSocket port |
| `NODE_BIN` | `node` | Node executable used for the PTY bridge |
| `DEFAULT_SHELL` | `$SHELL` or `/bin/bash` | Shell used for new panes |
| `DEFAULT_CWD` | current process cwd | Working directory for new sessions and panes |
| `TMUX_BIN` | `tmux` | `tmux` executable |
| `SESSION_PREFIX` | `rt` | Prefix for generated session names |

## API

- `GET /api/meta`
- `GET /api/sessions`
- `POST /api/sessions`
- `DELETE /api/sessions/:sessionName`
- `GET /api/sessions/:sessionName/state`
- `GET /api/sessions/:sessionName/panes`
- `POST /api/sessions/:sessionName/panes`
- `POST /api/sessions/:sessionName/windows/:windowIndex/select`
- `POST /api/sessions/:sessionName/panes/:paneId/select`
- `DELETE /api/sessions/:sessionName/panes/:paneId`
- `WS /ws/terminal/:sessionName`

## Notes

- There is no auth layer in this scaffold. Treat it as local-only until you put it behind real authentication and transport security.
- The browser terminal displays the actual `tmux` client, so native `tmux` keybindings still work.
