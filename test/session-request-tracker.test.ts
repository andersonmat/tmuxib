import { describe, expect, test } from "bun:test";

import { SessionRequestTracker } from "../public/session-request-tracker";

describe("SessionRequestTracker", () => {
  test("keeps only the latest session-list request current", () => {
    const tracker = new SessionRequestTracker();
    const firstRequest = tracker.beginSessionListRequest();
    const secondRequest = tracker.beginSessionListRequest();

    expect(tracker.isLatestSessionListRequest(firstRequest)).toBe(false);
    expect(tracker.isLatestSessionListRequest(secondRequest)).toBe(true);
  });

  test("invalidates stale session-state requests on newer requests, generation changes, and session switches", () => {
    const tracker = new SessionRequestTracker();
    const firstRequest = tracker.beginSessionStateRequest("alpha");

    expect(tracker.canApplySessionState(firstRequest, "alpha")).toBe(true);
    expect(tracker.canApplySessionState(firstRequest, "beta")).toBe(false);

    const secondRequest = tracker.beginSessionStateRequest("alpha");

    expect(tracker.canApplySessionState(firstRequest, "alpha")).toBe(false);
    expect(tracker.canApplySessionState(secondRequest, "alpha")).toBe(true);

    tracker.advanceSessionGeneration();

    expect(tracker.canApplySessionState(secondRequest, "alpha")).toBe(false);
  });
});
