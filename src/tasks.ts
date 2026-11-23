import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { type FileHandle, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { normalizeAfter, orderDagItems } from "./dag.ts";

export const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const MAX_TIMEOUT_SECONDS = 2_147_483;

export interface RunOptions {
  name: string;
  command: string;
  description?: string;
  timeoutSeconds?: number;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
  after?: string[];
}

export interface DagNodeOptions extends RunOptions {
  key: string;
}

interface TaskBase {
  id: string;
  name: string;
  command: string;
  description?: string;
  pid: number | undefined;
  cwd: string;
  outputPath: string;
  resultPath: string;
  queuedAt?: string;
  startedAt?: string;
  after?: string[];
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
}

export type RunningTask = TaskBase & {
  status: "running";
  startedAt: string;
};

export type QueuedTask = TaskBase & {
  status: "queued";
  queuedAt: string;
  after: string[];
};

export type LiveTask = RunningTask | QueuedTask;

interface Exit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type Result = TaskBase &
  Exit & {
    status: "completed" | "failed" | "killed";
    finishedAt: string;
    error?: string;
    metadataError?: string;
  };

export interface TaskHandle {
  task: LiveTask;
  started: Promise<RunningTask | undefined>;
  done: Promise<Result>;
}

export interface DagTaskHandle extends TaskHandle {
  key: string;
}

type Child = ChildProcessByStdio<null, Readable, Readable>;
interface StopReason {
  status: "failed" | "killed";
  error: string;
}
type Cancel = (reason: string) => Promise<Result>;
interface TrackedTask {
  done: Promise<Result>;
  settled: boolean;
}

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
  task: Omit<TaskBase, "pid" | "startedAt">,
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
  readonly task: TaskBase & { startedAt: string };

  constructor(child: Child, task: TaskBase & { startedAt: string }, log: FileHandle) {
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
    const task: RunningTask = { ...this.task, status: "running" };
    return { task, started: Promise.resolve(task), done };
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

function unstartedResult(
  task: Omit<TaskBase, "pid" | "startedAt">,
  status: "failed" | "killed",
  error: string,
): Promise<Result> {
  return saveResult({
    ...task,
    pid: undefined,
    exitCode: null,
    signal: null,
    status,
    finishedAt: new Date().toISOString(),
    error,
  });
}

function createQueuedTask(
  task: Omit<TaskBase, "pid" | "startedAt"> & { queuedAt: string; after: string[] },
  options: RunOptions,
  waitFor: Promise<Result>[],
  active: Map<string, Cancel>,
  getShutdownReason: () => string | undefined,
): TaskHandle {
  let cancelReason: string | undefined;
  let triggerCancel: (() => void) | undefined;
  const cancelled = new Promise<void>((resolve) => {
    triggerCancel = resolve;
  });
  let resolveStarted!: (running: RunningTask | undefined) => void;
  const started = new Promise<RunningTask | undefined>((resolve) => {
    resolveStarted = resolve;
  });

  const checkQueuedAdmission = () => {
    const stopReason = cancelReason ?? getShutdownReason();
    if (stopReason !== undefined) {
      throw new Error(stopReason);
    }
  };

  const runAfterDeps = async (): Promise<Result> => {
    await Promise.race([Promise.all(waitFor), cancelled]);
    const stopReason = cancelReason ?? getShutdownReason();
    if (stopReason !== undefined) {
      active.delete(task.id);
      resolveStarted(undefined);
      return unstartedResult(task, "killed", stopReason);
    }
    try {
      const running = await startProcess(task, options, checkQueuedAdmission, active);
      resolveStarted(running.task);
      return await running.done;
    } catch (error) {
      active.delete(task.id);
      resolveStarted(undefined);
      const lateStop = cancelReason ?? getShutdownReason();
      return unstartedResult(task, lateStop === undefined ? "failed" : "killed", lateStop ?? message(error));
    }
  };

  const done = runAfterDeps();
  active.set(task.id, (reason) => {
    if (cancelReason === undefined) {
      cancelReason = reason;
      triggerCancel?.();
    }
    return done;
  });

  return { task: { ...task, pid: undefined, status: "queued" }, started, done };
}

async function createTaskDirectory(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = randomBytes(4).toString("hex");
    const directory = join(root, id);
    try {
      await mkdir(directory, { mode: 0o700 });
      return { id, directory };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error("Could not allocate a unique background task ID");
}

async function settleTask(done: Promise<Result>, entry: TrackedTask): Promise<Result> {
  try {
    return await done;
  } finally {
    entry.settled = true;
  }
}

function resolveDependencies(after: string[], known: Map<string, TrackedTask>) {
  const waitFor: Promise<Result>[] = [];
  for (const depId of after) {
    const dep = known.get(depId);
    if (!dep) {
      throw new Error(`Unknown dependency task ID: ${depId}`);
    }
    if (!dep.settled) {
      waitFor.push(dep.done);
    }
  }
  return waitFor;
}

function trackKnown(handle: TaskHandle, known: Map<string, TrackedTask>): TaskHandle {
  const entry: TrackedTask = { done: handle.done, settled: false };
  entry.done = settleTask(handle.done, entry);
  known.set(handle.task.id, entry);
  return { task: handle.task, started: handle.started, done: entry.done };
}

interface LaunchContext {
  active: Map<string, Cancel>;
  known: Map<string, TrackedTask>;
  getShutdownReason: () => string | undefined;
  checkAdmission: (signal?: AbortSignal) => void;
}

async function launchTask(
  context: LaunchContext,
  cwd: string,
  taskRoot: string,
  name: string,
  options: RunOptions,
  after: string[],
  signal?: AbortSignal,
): Promise<TaskHandle> {
  const admit = () => context.checkAdmission(signal);
  admit();
  const waitFor = resolveDependencies(after, context.known);
  const { id, directory } = await createTaskDirectory(taskRoot);
  const notifyOnCompletion = options.notifyOnCompletion ?? true;
  const base: Omit<TaskBase, "pid" | "startedAt"> = {
    id,
    name,
    command: options.command,
    cwd,
    description: options.description,
    outputPath: join(directory, "output.log"),
    resultPath: join(directory, "result.json"),
    after: after.length > 0 ? after : undefined,
    notifyOnCompletion,
    triggerOnCompletion: notifyOnCompletion && (options.triggerOnCompletion ?? true),
  };
  if (waitFor.length > 0) {
    const queued = createQueuedTask(
      { ...base, queuedAt: new Date().toISOString(), after },
      options,
      waitFor,
      context.active,
      context.getShutdownReason,
    );
    return trackKnown(queued, context.known);
  }
  try {
    const started = await startProcess(base, options, admit, context.active);
    return trackKnown(started, context.known);
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Preserve the original launch error if best-effort cleanup also fails.
    }
    throw error;
  }
}

export function createTasks() {
  let shutdownReason: string | undefined;
  const active = new Map<string, Cancel>();
  const known = new Map<string, TrackedTask>();

  function checkAdmission(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (shutdownReason !== undefined) {
      throw new Error("Pi is shutting down this bg_run session");
    }
  }

  const context: LaunchContext = {
    active,
    known,
    getShutdownReason: () => shutdownReason,
    checkAdmission,
  };

  async function run(cwd: string, taskRoot: string, options: RunOptions, signal?: AbortSignal): Promise<TaskHandle> {
    checkAdmission(signal);
    const name = validate(options);
    const after = normalizeAfter(options.after);
    return launchTask(context, cwd, taskRoot, name, options, after, signal);
  }

  async function runDag(
    cwd: string,
    taskRoot: string,
    nodes: readonly DagNodeOptions[],
    signal?: AbortSignal,
  ): Promise<DagTaskHandle[]> {
    checkAdmission(signal);
    const ordered = orderDagItems(nodes, (id) => known.has(id));
    const names = ordered.map((item) => validate(item.node));
    const keyToId = new Map<string, string>();
    const created: DagTaskHandle[] = [];
    const results = new Array<DagTaskHandle>(nodes.length);
    try {
      for (const [position, item] of ordered.entries()) {
        const after = normalizeAfter(item.after.map((dep) => keyToId.get(dep) ?? dep));
        const handle = await launchTask(context, cwd, taskRoot, names[position], item.node, after, signal);
        const dagHandle: DagTaskHandle = { key: item.key, ...handle };
        keyToId.set(item.key, handle.task.id);
        created.push(dagHandle);
        results[item.index] = dagHandle;
      }
      return results;
    } catch (error) {
      await Promise.all(created.map((item) => stop(item.task.id, "Aborted DAG launch")));
      throw error;
    }
  }

  async function stop(id: string, reason: string) {
    return active.get(id)?.(reason);
  }

  async function shutdown(reason: string) {
    shutdownReason = reason;
    await Promise.all([...active.values()].map((cancel) => cancel(reason)));
  }

  return { run, runDag, stop, shutdown };
}
