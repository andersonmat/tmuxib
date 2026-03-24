import { spawn } from "node:child_process";
import { resolve } from "node:path";

const projectDirectory = resolve(import.meta.dir, "..");
const children: Array<ReturnType<typeof spawn>> = [];

await run(["bun", "run", "build:client:dev"]);

children.push(
  spawn("bun", ["run", "dev:client"], {
    cwd: projectDirectory,
    stdio: "inherit"
  }),
  spawn("bun", ["run", "dev:server"], {
    cwd: projectDirectory,
    stdio: "inherit"
  })
);

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdown(0);
  });
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    if (signal) {
      console.error(`[dev] child exited via ${signal}`);
      shutdown(1);
      return;
    }

    if ((code ?? 0) !== 0) {
      console.error(`[dev] child exited with code ${code ?? 1}`);
      shutdown(code ?? 1);
    }
  });
}

await new Promise<void>(() => {
  // The process exits through shutdown().
});

function shutdown(exitCode: number) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }

    process.exit(exitCode);
  }, 250);
}

async function run(command: string[]) {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: projectDirectory,
      stdio: "inherit"
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        rejectRun(new Error(`${command.join(" ")} exited via ${signal}`));
        return;
      }

      if ((code ?? 0) !== 0) {
        rejectRun(new Error(`${command.join(" ")} exited with code ${code ?? 1}`));
        return;
      }

      resolveRun();
    });
  });
}
