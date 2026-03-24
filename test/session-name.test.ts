import { describe, expect, test } from "bun:test";

import { isSafeSessionName, normalizeSessionName } from "../src/session-name";

describe("normalizeSessionName", () => {
  test("keeps an already safe session name", () => {
    expect(normalizeSessionName("tmuxib-dev", "tmuxib")).toBe("tmuxib-dev");
  });

  test("normalizes noisy input into a safe slug", () => {
    expect(normalizeSessionName("  Demo Session  ", "tmuxib")).toBe("demo-session");
  });

  test("falls back to a generated name when the input has no usable characters", () => {
    expect(normalizeSessionName("!!!", "tmuxib")).toMatch(/^tmuxib-[a-f0-9]{6}$/);
  });

  test("reports safe names correctly", () => {
    expect(isSafeSessionName("tmuxib-dev.1")).toBe(true);
    expect(isSafeSessionName("bad session")).toBe(false);
  });
});
