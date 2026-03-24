import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { normalizeSessionName } from "./session-name";
import { PANE_FORMAT, parsePanes, parseSessions, parseWindows, SESSION_FORMAT, WINDOW_FORMAT } from "./tmux-formats";

const execFileAsync = promisify(execFile);

interface TmuxOptions {
  binary: string;
  defaultShell: string;
  defaultCwd: string;
  sessionPrefix: string;
}

interface ExecFileFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

class TmuxCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code?: number | string
  ) {
    super(message);
    this.name = "TmuxCommandError";
  }
}

export interface CreateSessionInput {
  name?: string;
  cwd?: string;
}

export interface SplitPaneInput {
  sessionName: string;
  targetPane?: string;
  direction?: "vertical" | "horizontal";
  cwd?: string;
}

export class TmuxService {
  constructor(private readonly options: TmuxOptions) {}

  attachArgs(sessionName: string) {
    return ["attach-session", "-t", sessionName];
  }

  controlArgs(sessionName: string) {
    return ["-C", "attach-session", "-r", "-t", sessionName];
  }

  async listSessions() {
    const output = await this.exec(["list-sessions", "-F", SESSION_FORMAT], { allowEmptyServer: true });
    return parseSessions(output);
  }

  async getSession(sessionName: string) {
    const sessions = await this.listSessions();
    const session = sessions.find((entry) => entry.name === sessionName);

    if (!session) {
      throw new Error(`tmux session "${sessionName}" was not found`);
    }

    return session;
  }

  async hasSession(sessionName: string) {
    try {
      await this.exec(["has-session", "-t", sessionName]);
      return true;
    } catch (error) {
      if (isMissingTarget(error) || isNoServer(error)) {
        return false;
      }

      throw error;
    }
  }

  async createSession(input: CreateSessionInput) {
    const sessionName = normalizeSessionName(input.name, this.options.sessionPrefix);
    await this.ensureSession(sessionName, input.cwd);
    return this.getSession(sessionName);
  }

  async ensureSession(sessionName: string, cwd = this.options.defaultCwd) {
    const exists = await this.hasSession(sessionName);

    if (exists) {
      return;
    }

    await this.exec([
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      cwd
    ]);
  }

  async listPanes(sessionName: string) {
    const output = await this.exec(["list-panes", "-s", "-t", sessionTarget(sessionName), "-F", PANE_FORMAT]);
    return parsePanes(output);
  }

  async listWindows(sessionName: string) {
    const output = await this.exec(["list-windows", "-t", sessionTarget(sessionName), "-F", WINDOW_FORMAT]);
    return parseWindows(output);
  }

  async getSessionState(sessionName: string) {
    const [windows, panes] = await Promise.all([
      this.listWindows(sessionName),
      this.listPanes(sessionName)
    ]);

    return { windows, panes };
  }

  async splitPane(input: SplitPaneInput) {
    const targetPane = input.targetPane ?? (await this.currentPane(input.sessionName));
    const directionFlag = input.direction === "horizontal" ? "-h" : "-v";

    await this.exec([
      "split-window",
      "-P",
      "-F",
      "#{pane_id}",
      directionFlag,
      "-t",
      targetPane,
      "-c",
      input.cwd ?? this.options.defaultCwd
    ]);
  }

  async selectPane(paneId: string) {
    await this.exec(["select-pane", "-t", paneId]);
  }

  async selectWindow(sessionName: string, windowIndex: string) {
    await this.exec(["select-window", "-t", windowTarget(sessionName, windowIndex)]);
  }

  async killPane(paneId: string) {
    await this.exec(["kill-pane", "-t", paneId]);
  }

  async killSession(sessionName: string) {
    await this.exec(["kill-session", "-t", sessionName]);
  }

  private async currentPane(sessionName: string) {
    const output = await this.exec(["display-message", "-p", "-t", sessionTarget(sessionName), "#{pane_id}"]);
    return output.trim();
  }

  private async exec(args: string[], options: { allowEmptyServer?: boolean } = {}) {
    try {
      const result = await execFileAsync(this.options.binary, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });

      return result.stdout.trimEnd();
    } catch (error) {
      if (options.allowEmptyServer && isNoServer(error)) {
        return "";
      }

      throw wrapTmuxError(args, error);
    }
  }
}

function wrapTmuxError(args: string[], error: unknown) {
  const failure = error as ExecFileFailure;
  const stderr = failure.stderr?.trim() ?? "unknown tmux error";
  return new TmuxCommandError(`tmux ${args.join(" ")} failed: ${stderr}`, stderr, failure.code);
}

function isNoServer(error: unknown) {
  const stderr = readStderr(error);
  return (
    stderr.includes("no server running") ||
    /error connecting to .*\(No such file or directory\)/i.test(stderr)
  );
}

function isMissingTarget(error: unknown) {
  return /can't find (session|pane|window)/i.test(readStderr(error));
}

function readStderr(error: unknown) {
  if (error instanceof TmuxCommandError) {
    return error.stderr;
  }

  const failure = error as ExecFileFailure;
  return failure.stderr ?? "";
}

function sessionTarget(sessionName: string) {
  return `${sessionName}:`;
}

function windowTarget(sessionName: string, windowIndex: string) {
  return `${sessionName}:${windowIndex}`;
}
