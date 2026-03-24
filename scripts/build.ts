export {};

const mode = process.argv[2];
const supportedExecutableHost = process.platform === "linux" && process.arch === "x64";
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
  const result = await Bun.build({
    entrypoints,
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
