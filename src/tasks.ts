import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const MAX_TIMEOUT_SECONDS = 2_147_483; // Largest whole seconds accepted by Node's timer.

export interface RunOptions {
  name: string;
  command: string;
  description?: string;
  timeoutSeconds?: number;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
}

interface Task {
  id: string;
  name: string;
  description?: string;
  pid: number | undefined;
  cwd: string;
  outputPath: string;
  resultPath: string;
  startedAt: string;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
}

type Result = Task & {
  status: "completed" | "failed" | "killed";
  finishedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  metadataError?: string;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTasks() {
  let closed = false;
  const active = new Map<string, (reason: string) => Promise<Result>>();

  async function run(
    cwd: string,
    taskRoot: string,
    options: RunOptions,
    signal?: AbortSignal,
  ) {
    const checkAdmission = () => {
      signal?.throwIfAborted();
      if (closed) {
        throw new Error("Pi is shutting down this bg_run session");
      }
    };
    checkAdmission();
    if (process.platform === "win32") {
      throw new Error("bg_run requires a POSIX host with Bash");
    }
    const name = options.name.trim();
    if (!name || name.length > 120) {
      throw new Error("bg_run needs a name of 1–120 characters");
    }
    if (!options.command.trim()) {
      throw new Error("Background command is empty");
    }
    const { timeoutSeconds } = options;
    if (
      timeoutSeconds !== undefined &&
      (!Number.isFinite(timeoutSeconds) ||
        timeoutSeconds <= 0 ||
        timeoutSeconds > MAX_TIMEOUT_SECONDS)
    ) {
      throw new Error(
        `timeoutSeconds must be positive and at most ${MAX_TIMEOUT_SECONDS}`,
      );
    }
    const id = randomUUID();
    await mkdir(taskRoot, { recursive: true, mode: 0o700 });
    const directory = join(taskRoot, id);
    await mkdir(directory, { mode: 0o700 });
    const outputPath = join(directory, "output.log");
    const resultPath = join(directory, "result.json");
    try {
      const log = await open(outputPath, "wx", 0o600);
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        checkAdmission();
        child = spawn("bash", ["-c", options.command], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        await log.close();
        throw error;
      }

      const notifyOnCompletion = options.notifyOnCompletion ?? true;
      const task: Task = {
        id,
        name,
        cwd,
        outputPath,
        resultPath,
        description: options.description,
        pid: child.pid,
        startedAt: new Date().toISOString(),
        notifyOnCompletion,
        triggerOnCompletion:
          notifyOnCompletion && (options.triggerOnCompletion ?? true),
      };
      let terminal = false;
      let stopped: { status: "failed" | "killed"; error: string } | undefined;
      let closePipes: NodeJS.Timeout | undefined;
      function stop(status: "failed" | "killed", error: string) {
        if (stopped || (terminal && status === "killed")) {
          return;
        }
        stopped = { status, error };
        if (terminal) {
          return;
        }
        try {
          // detached: true makes Bash the leader of a new POSIX process group.
          if (task.pid !== undefined) {
            process.kill(-task.pid, "SIGKILL");
          }
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") {
            stopped = {
              status: "failed",
              error: `${error}; could not stop Bash group: ${message(cause)}`,
            };
          }
        }
        // Drain buffered output, but a process that left Bash's group could hold the pipes open.
        closePipes = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, 250);
      }

      let timer: NodeJS.Timeout | undefined;
      let spawnError: string | undefined;
      child.on("error", (error) => {
        spawnError = message(error);
      });
      const started = once(child, "spawn");
      const merged = new PassThrough();
      const exited = new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.once("close", (exitCode, signal) => {
          terminal = true;
          clearTimeout(timer);
          clearTimeout(closePipes);
          merged.end();
          resolve({ exitCode, signal });
        });
      });
      let bytes = 0;
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          const size = Math.min(chunk.length, MAX_OUTPUT_BYTES - bytes);
          bytes += size;
          if (size < chunk.length) {
            stop("failed", "Output exceeded the 20 MiB limit");
          }
          callback(null, chunk.subarray(0, size));
        },
      });
      const drained = pipeline(merged, bounded, log.createWriteStream()).catch(
        (error: unknown) => {
          stop("failed", `Could not write task output: ${message(error)}`);
          // Keep draining the pipes if the log file is no longer writable.
          child.stdout.resume();
          child.stderr.resume();
          return `Could not write task output: ${message(error)}`;
        },
      );
      child.stdout.pipe(merged, { end: false });
      child.stderr.pipe(merged, { end: false });
      if (timeoutSeconds !== undefined) {
        timer = setTimeout(
          () => stop("failed", `Timed out after ${timeoutSeconds}s`),
          timeoutSeconds * 1000,
        );
      }

      const cancel = (reason: string) => {
        stop("killed", reason);
        return done;
      };
      const done = Promise.all([exited, drained])
        .then(async ([exit, logError]): Promise<Result> => {
          const error =
            stopped?.error ??
            logError ??
            spawnError ??
            (exit.signal
              ? `Bash exited on ${exit.signal}`
              : exit.exitCode !== 0
                ? `Bash exited with code ${exit.exitCode}`
                : undefined);
          const result: Result = {
            ...task,
            ...exit,
            status: stopped?.status ?? (error ? "failed" : "completed"),
            finishedAt: new Date().toISOString(),
            error,
          };
          try {
            const temporary = `${resultPath}.tmp`;
            await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, {
              flag: "wx",
              mode: 0o600,
            });
            await rename(temporary, resultPath);
          } catch (cause) {
            result.metadataError = `Could not save result: ${message(cause)}`;
          }
          return result;
        })
        .finally(() => active.delete(id));
      active.set(id, cancel);

      try {
        await started;
      } catch (error) {
        await done;
        throw new Error(`Could not start Bash: ${message(error)}`, {
          cause: error,
        });
      }
      return { task: { ...task, status: "running" as const }, done };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function stop(id: string, reason: string) {
    return active.get(id)?.(reason);
  }

  async function shutdown(reason: string) {
    closed = true;
    await Promise.all([...active.values()].map((cancel) => cancel(reason)));
  }

  return { run, stop, shutdown };
}
