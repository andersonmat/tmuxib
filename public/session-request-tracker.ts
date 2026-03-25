export interface SessionStateRequestToken {
  sessionName: string;
  requestId: number;
  sessionGeneration: number;
}

export class SessionRequestTracker {
  private sessionListRequestId = 0;
  private sessionStateRequestId = 0;
  private currentSessionGeneration = 0;

  beginSessionListRequest() {
    return ++this.sessionListRequestId;
  }

  isLatestSessionListRequest(requestId: number) {
    return this.sessionListRequestId === requestId;
  }

  beginSessionStateRequest(sessionName: string): SessionStateRequestToken {
    return {
      sessionName,
      requestId: ++this.sessionStateRequestId,
      sessionGeneration: this.currentSessionGeneration
    };
  }

  canApplySessionState(request: SessionStateRequestToken, currentSession: string | null) {
    return (
      this.sessionStateRequestId === request.requestId &&
      this.currentSessionGeneration === request.sessionGeneration &&
      currentSession === request.sessionName
    );
  }

  advanceSessionGeneration() {
    this.currentSessionGeneration += 1;
  }
}
