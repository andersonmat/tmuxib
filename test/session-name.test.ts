import { describe, expect, test } from "bun:test";

import { isSafeSessionName, normalizeSessionName } from "../src/session-name";

describe("normalizeSessionName", () => {
  test("keeps an already safe session name", () => {
    expect(normalizeSessionName("rt-dev", "rt")).toBe("rt-dev");
  });

  test("normalizes noisy input into a safe slug", () => {
    expect(normalizeSessionName("  Demo Session  ", "rt")).toBe("demo-session");
  });

  test("falls back to a generated name when the input has no usable characters", () => {
    expect(normalizeSessionName("!!!", "term")).toMatch(/^term-[a-f0-9]{6}$/);
  });

  test("reports safe names correctly", () => {
    expect(isSafeSessionName("rt-dev.1")).toBe(true);
    expect(isSafeSessionName("bad session")).toBe(false);
  });
});
