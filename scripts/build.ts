export {};

import { spawnSync } from "node:child_process";

const mode = process.argv[2];
const supportedExecutableHost = process.platform === "linux" && process.arch === "x64";
const helperSource = "src/vendor/tmuxib-pty-helper.c";
const helperBinary = "src/vendor/tmuxib-pty-helper";
const entrypoints = [
  "src/index.ts",
  "src/vendor/node-pty/pty.node"
];

if (!supportedExecutableHost) {
  console.error("tmuxib executable builds are currently supported on linux-x64 only");
  process.exit(1);
}

if (mode === "server") {
  const result = await Bun.build({
    entrypoints,
    target: "bun",
    outdir: "dist/server",
    naming: {
      entry: "server-[name].[ext]",
      asset: "[name].[ext]"
    }
  });

  if (!result.success) {
    reportBuildErrors(result.logs);
    process.exit(1);
  }

  process.exit(0);
}

if (mode === "exe") {
  buildNativePtyHelper();

  const result = await Bun.build({
    entrypoints: [...entrypoints, helperBinary],
    target: "bun",
    compile: {
      outfile: "dist/tmuxib"
    },
    naming: {
      asset: "[name].[ext]"
    }
  });

  if (!result.success) {
    reportBuildErrors(result.logs);
    process.exit(1);
  }

  process.exit(0);
}

console.error("usage: bun run scripts/build.ts <server|exe>");
process.exit(1);

function reportBuildErrors(logs: ReadonlyArray<{ message: string }>) {
  for (const log of logs) {
    console.error(log.message);
  }
}

function buildNativePtyHelper() {
  const result = spawnSync(
    "cc",
    [
      "-O2",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-o",
      helperBinary,
      helperSource,
      "-lutil"
    ],
    {
      stdio: "inherit"
    }
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
