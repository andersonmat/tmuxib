import { describe, expect, test } from "bun:test";

import { app } from "../src/app";

describe("app", () => {
  test("returns runtime metadata", async () => {
    const response = await app.request("/api/meta");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.host).toBe("127.0.0.1");
    expect(payload.port).toBe(3000);
    expect(typeof payload.shell).toBe("string");
    expect(typeof payload.defaultCwd).toBe("string");
  });

  test("returns a JSON 404 payload for unknown routes", async () => {
    const response = await app.request("/api/does-not-exist");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
