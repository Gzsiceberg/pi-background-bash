import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { type FileHandle, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const MAX_TIMEOUT_SECONDS = 2_147_483;

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

interface Exit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type Result = Task &
  Exit & {
    status: "completed" | "failed" | "killed";
    finishedAt: string;
    error?: string;
    metadataError?: string;
  };

type Child = ChildProcessByStdio<null, Readable, Readable>;
interface StopReason {
  status: "failed" | "killed";
  error: string;
}
type Cancel = (reason: string) => Promise<Result>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validate(options: RunOptions) {
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
    (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_TIMEOUT_SECONDS)
  ) {
    throw new Error(`timeoutSeconds must be positive and at most ${MAX_TIMEOUT_SECONDS}`);
  }
  return name;
}

async function startProcess(
  task: Omit<Task, "pid" | "startedAt">,
  options: RunOptions,
  checkAdmission: () => void,
  active: Map<string, Cancel>,
) {
  const log = await open(task.outputPath, "wx", 0o600);
  let child: Child;
  try {
    checkAdmission();
    child = spawn("bash", ["-c", options.command], {
      cwd: task.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    await log.close();
    throw error;
  }
  const processTask = new TaskProcess(child, { ...task, pid: child.pid, startedAt: new Date().toISOString() }, log);
  return processTask.track(active, options.timeoutSeconds);
}

function exitError(exit: Exit) {
  if (exit.signal) {
    return `Bash exited on ${exit.signal}`;
  }
  return exit.exitCode === 0 ? undefined : `Bash exited with code ${exit.exitCode}`;
}

async function saveResult(result: Result) {
  try {
    const temporary = `${result.resultPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, result.resultPath);
  } catch (cause) {
    result.metadataError = `Could not save result: ${message(cause)}`;
  }
  return result;
}

class TaskProcess {
  private readonly merged = new PassThrough();
  private terminal = false;
  private stopped?: StopReason;
  private closePipes?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private spawnError?: string;
  private readonly exited: Promise<Exit>;
  private readonly drained: Promise<string | undefined>;
  private readonly started: Promise<unknown>;

  private readonly child: Child;
  readonly task: Task;

  constructor(child: Child, task: Task, log: FileHandle) {
    this.child = child;
    this.task = task;
    child.on("error", (error) => {
      this.spawnError = message(error);
    });
    this.started = once(child, "spawn");
    this.exited = new Promise((resolve) => {
      child.once("close", (exitCode, signal) => {
        this.terminal = true;
        clearTimeout(this.timer);
        clearTimeout(this.closePipes);
        this.merged.end();
        resolve({ exitCode, signal });
      });
    });
    this.drained = this.drainOutput(log);
    child.stdout.pipe(this.merged, { end: false });
    child.stderr.pipe(this.merged, { end: false });
  }

  private async drainOutput(log: FileHandle) {
    let bytes = 0;
    const bounded = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        const size = Math.min(chunk.length, MAX_OUTPUT_BYTES - bytes);
        bytes += size;
        if (size < chunk.length) {
          this.stop("failed", "Output exceeded the 20 MiB limit");
        }
        callback(null, chunk.subarray(0, size));
      },
    });
    try {
      await pipeline(this.merged, bounded, log.createWriteStream());
    } catch (error) {
      const reason = `Could not write task output: ${message(error)}`;
      this.stop("failed", reason);
      this.child.stdout.resume();
      this.child.stderr.resume();
      return reason;
    }
  }

  private stop(status: StopReason["status"], error: string) {
    if (this.stopped || (this.terminal && status === "killed")) {
      return;
    }
    this.stopped = { status, error };
    if (this.terminal) {
      return;
    }
    try {
      // Detached Bash leads an owned POSIX process group.
      if (this.task.pid !== undefined) {
        process.kill(-this.task.pid, "SIGKILL");
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") {
        this.stopped = { status: "failed", error: `${error}; could not stop Bash group: ${message(cause)}` };
      }
    }
    // Allow buffered data to drain without waiting for escaped descendants forever.
    this.closePipes = setTimeout(() => {
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }, 250);
  }

  async track(active: Map<string, Cancel>, timeoutSeconds?: number) {
    if (timeoutSeconds !== undefined) {
      this.timer = setTimeout(() => this.stop("failed", `Timed out after ${timeoutSeconds}s`), timeoutSeconds * 1000);
    }
    const done = this.finish(active);
    active.set(this.task.id, (reason) => {
      this.stop("killed", reason);
      return done;
    });
    try {
      await this.started;
    } catch (error) {
      await done;
      throw new Error(`Could not start Bash: ${message(error)}`, { cause: error });
    }
    return { task: { ...this.task, status: "running" as const }, done };
  }

  private async finish(active: Map<string, Cancel>): Promise<Result> {
    try {
      const [exit, logError] = await Promise.all([this.exited, this.drained]);
      const error = this.stopped?.error ?? logError ?? this.spawnError ?? exitError(exit);
      return await saveResult({
        ...this.task,
        ...exit,
        status: this.stopped?.status ?? (error ? "failed" : "completed"),
        finishedAt: new Date().toISOString(),
        error,
      });
    } finally {
      active.delete(this.task.id);
    }
  }
}

export function createTasks() {
  let closed = false;
  const active = new Map<string, Cancel>();

  async function run(cwd: string, taskRoot: string, options: RunOptions, signal?: AbortSignal) {
    const checkAdmission = () => {
      signal?.throwIfAborted();
      if (closed) {
        throw new Error("Pi is shutting down this bg_run session");
      }
    };
    checkAdmission();
    const name = validate(options);
    const id = randomUUID();
    await mkdir(taskRoot, { recursive: true, mode: 0o700 });
    const directory = join(taskRoot, id);
    await mkdir(directory, { mode: 0o700 });
    const notifyOnCompletion = options.notifyOnCompletion ?? true;
    try {
      return await startProcess(
        {
          id,
          name,
          cwd,
          description: options.description,
          outputPath: join(directory, "output.log"),
          resultPath: join(directory, "result.json"),
          notifyOnCompletion,
          triggerOnCompletion: notifyOnCompletion && (options.triggerOnCompletion ?? true),
        },
        options,
        checkAdmission,
        active,
      );
    } catch (error) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        // Preserve the original launch error if best-effort cleanup also fails.
      }
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
