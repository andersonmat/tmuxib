import { randomBytes } from "node:crypto";

const SAFE_SESSION_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;

function token() {
  return randomBytes(3).toString("hex");
}

export function isSafeSessionName(value: string) {
  return SAFE_SESSION_NAME.test(value);
}

export function normalizeSessionName(input: string | undefined, prefix: string) {
  const base = (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (base && isSafeSessionName(base)) {
    return base;
  }

  const scopedPrefix = prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "tmuxib";

  return `${scopedPrefix}-${token()}`;
}
