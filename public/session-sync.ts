export interface SessionSyncOptions {
  refreshSessions?: boolean;
  ignoreHidden?: boolean;
  forceResize?: boolean;
}

interface ResolvedSessionSyncOptions {
  refreshSessions: boolean;
  ignoreHidden: boolean;
  forceResize: boolean;
}

interface SessionSyncControllerOptions {
  getHasCurrentSession(): boolean;
  getIsDocumentHidden(): boolean;
  loadSessions(): Promise<void>;
  loadSessionState(): Promise<void>;
  refreshSessionListIfStale(): Promise<void>;
  scheduleForceResize(): void;
  reportError(error: unknown): void;
}

export class SessionSyncController {
  private activeSync: Promise<void> | null = null;
  private pendingSync: ResolvedSessionSyncOptions | null = null;
  private scheduledFlush: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(private readonly options: SessionSyncControllerOptions) {}

  clear() {
    if (this.scheduledFlush) {
      globalThis.clearTimeout(this.scheduledFlush);
      this.scheduledFlush = null;
    }

    this.pendingSync = null;
  }

  request(options: SessionSyncOptions = {}) {
    this.pendingSync = mergeSessionSyncOptions(this.pendingSync, options);

    if (this.activeSync || this.scheduledFlush) {
      return;
    }

    this.scheduledFlush = globalThis.setTimeout(() => {
      this.scheduledFlush = null;

      void this.flush().catch((error) => {
        this.options.reportError(error);
      });
    }, 0);
  }

  async run(options: SessionSyncOptions = {}) {
    this.pendingSync = mergeSessionSyncOptions(this.pendingSync, options);

    do {
      await this.flush();
    } while (this.pendingSync || this.activeSync);
  }

  private async flush() {
    if (this.scheduledFlush) {
      globalThis.clearTimeout(this.scheduledFlush);
      this.scheduledFlush = null;
    }

    if (this.activeSync) {
      await this.activeSync;
      return;
    }

    this.activeSync = this.drain();

    try {
      await this.activeSync;
    } finally {
      this.activeSync = null;

      if (this.pendingSync && this.scheduledFlush === null) {
        this.request();
      }
    }
  }

  private async drain() {
    while (this.pendingSync) {
      const nextSync = this.pendingSync;
      this.pendingSync = null;

      if (!this.options.getHasCurrentSession()) {
        continue;
      }

      if (!nextSync.ignoreHidden && this.options.getIsDocumentHidden()) {
        continue;
      }

      if (nextSync.refreshSessions) {
        await this.options.loadSessions();
      }

      if (!this.options.getHasCurrentSession()) {
        continue;
      }

      await this.options.loadSessionState();

      if (!nextSync.refreshSessions) {
        await this.options.refreshSessionListIfStale();
      }

      if (nextSync.forceResize) {
        this.options.scheduleForceResize();
      }
    }
  }
}

function mergeSessionSyncOptions(
  existing: ResolvedSessionSyncOptions | null,
  incoming: SessionSyncOptions
): ResolvedSessionSyncOptions {
  return {
    refreshSessions: (existing?.refreshSessions ?? false) || (incoming.refreshSessions ?? false),
    ignoreHidden: (existing?.ignoreHidden ?? false) || (incoming.ignoreHidden ?? false),
    forceResize: (existing?.forceResize ?? false) || (incoming.forceResize ?? false)
  };
}
