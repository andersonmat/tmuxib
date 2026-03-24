import type { IPty, IPtyForkOptions } from "node-pty";

type NodePtyModule = {
  spawn: (file?: string, args?: string[], options?: IPtyForkOptions) => IPty;
};
let cachedModule: NodePtyModule | null = null;

export function spawn(file: string, args: string[], options: IPtyForkOptions) {
  return loadNodePty().spawn(file, args, options);
}

function loadNodePty() {
  if (cachedModule) {
    return cachedModule;
  }

  if (process.platform === "linux" && process.arch === "x64") {
    cachedModule = require("./vendor/node-pty/lib/index.js") as NodePtyModule;
    return cachedModule;
  }

  cachedModule = require("node-pty") as NodePtyModule;
  return cachedModule;
}
