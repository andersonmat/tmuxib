import { describe, expect, test } from "bun:test";

import { nextSessionNameAfterRemoval, stableSessions } from "../public/session-order";
import type { SessionSummary } from "../public/types";

function session(name: string): SessionSummary {
  return {
    name,
    windows: 1,
    attached: 0,
    created: "now"
  };
}

describe("stableSessions", () => {
  test("sorts session names in a stable numeric-aware order", () => {
    expect(stableSessions([session("test-10"), session("test-2"), session("test-1")]).map((entry) => entry.name)).toEqual([
      "test-1",
      "test-2",
      "test-10"
    ]);
  });
});

describe("nextSessionNameAfterRemoval", () => {
  test("rotates to the next session after a removed middle session", () => {
    expect(
      nextSessionNameAfterRemoval(
        [session("alpha"), session("bravo"), session("charlie")],
        [session("alpha"), session("charlie")],
        "bravo"
      )
    ).toBe("charlie");
  });

  test("wraps to the first session when the removed session was last", () => {
    expect(
      nextSessionNameAfterRemoval(
        [session("alpha"), session("bravo"), session("charlie")],
        [session("alpha"), session("bravo")],
        "charlie"
      )
    ).toBe("alpha");
  });

  test("returns the first session when the removed session is unknown", () => {
    expect(
      nextSessionNameAfterRemoval(
        [session("alpha"), session("bravo")],
        [session("bravo"), session("charlie")],
        "delta"
      )
    ).toBe("bravo");
  });

  test("returns null when no sessions remain", () => {
    expect(nextSessionNameAfterRemoval([session("alpha")], [], "alpha")).toBeNull();
  });
});
