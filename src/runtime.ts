export function getRuntimeIdentity(defaultShell: string, defaultCwd: string) {
  return {
    user: process.env.USER ?? "unknown",
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    gid: typeof process.getgid === "function" ? process.getgid() : -1,
    shell: defaultShell,
    defaultCwd
  };
}
