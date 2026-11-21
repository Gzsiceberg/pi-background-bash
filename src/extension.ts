import { join, relative } from "node:path";

import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { plainText } from "./log-tail.ts";
import { createTaskPanel, type PanelTask } from "./task-panel.ts";
import { formatDuration } from "./task-presentation.ts";
import {
  createTasks,
  type DagNodeOptions,
  type LiveTask,
  MAX_TIMEOUT_SECONDS,
  type Result,
  type RunningTask,
  type RunOptions,
  type TaskHandle,
} from "./tasks.ts";

const notificationType = "background-task-notification";
const FOOTER_KEY = "pi-background-bash";
const MAX_FINISHED_JOBS = 5;

// Keep names and paths single-line and unable to close the notification tag.
function inlineText(value: string): string {
  return plainText(value)
    .replaceAll(/[\r\n]+/g, " ")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

function displayPath(cwd: string, target: string): string {
  const rel = relative(cwd, target);
  const preferred = rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : target;
  return inlineText(preferred);
}

function statusGlyph(status: LiveTask["status"] | Result["status"]): string {
  if (status === "running") {
    return "▶";
  }
  if (status === "queued") {
    return "◷";
  }
  if (status === "completed") {
    return "✓";
  }
  if (status === "failed") {
    return "✗";
  }
  return "■";
}

function footerStatus(jobs: Iterable<PanelTask>): string | undefined {
  let running = 0;
  let queued = 0;
  for (const job of jobs) {
    if (job.status === "running") {
      running++;
    } else if (job.status === "queued") {
      queued++;
    }
  }
  const parts: string[] = [];
  if (running > 0) {
    parts.push(`${running} running`);
  }
  if (queued > 0) {
    parts.push(`${queued} queued`);
  }
  return parts.length > 0 ? `bg ${parts.join(", ")} · /bg-tasks` : undefined;
}

function formatDependency(id: string, taskNames: ReadonlyMap<string, string>): string {
  const name = taskNames.get(id);
  return name ? `${inlineText(name)} (${id})` : id;
}

function attachAfterNames(task: LiveTask | Result, taskNames: ReadonlyMap<string, string>): PanelTask {
  if (!task.after?.length) {
    return task;
  }
  const afterNames: Record<string, string> = {};
  let found = false;
  for (const id of task.after) {
    const name = taskNames.get(id);
    if (name !== undefined) {
      afterNames[id] = name;
      found = true;
    }
  }
  return found ? { ...task, afterNames } : task;
}

function recordFinishedJob(
  jobs: Map<string, PanelTask>,
  finishedIds: string[],
  result: Result,
  taskNames: ReadonlyMap<string, string>,
): boolean {
  if (!jobs.delete(result.id)) {
    return false;
  }
  jobs.set(result.id, attachAfterNames(result, taskNames));
  finishedIds.push(result.id);
  if (finishedIds.length > MAX_FINISHED_JOBS) {
    jobs.delete(finishedIds.shift()!);
  }
  return true;
}

function createSession(pi: ExtensionAPI) {
  const tasks = createTasks();
  const jobs = new Map<string, PanelTask>();
  const taskNames = new Map<string, string>();
  const finishedIds: string[] = [];
  let shuttingDown = false;

  function updateFooter(ui: ExtensionUIContext) {
    ui.setStatus(FOOTER_KEY, footerStatus(jobs.values()));
  }

  function trackHandle(ctx: ExtensionContext, handle: TaskHandle) {
    taskNames.set(handle.task.id, handle.task.name);
    if (!shuttingDown && ctx.mode === "tui") {
      jobs.set(handle.task.id, attachAfterNames(handle.task, taskNames));
      updateFooter(ctx.ui);
    }
    if (handle.task.status === "queued") {
      void handleStart(ctx, handle.started);
    }
    void handleCompletion(ctx, handle.done);
  }

  async function startTask(ctx: ExtensionContext, options: RunOptions, signal?: AbortSignal) {
    const handle = await tasks.run(ctx.cwd, join(ctx.cwd, CONFIG_DIR_NAME, "tasks"), options, signal);
    trackHandle(ctx, handle);
    return handle.task;
  }

  async function startDag(ctx: ExtensionContext, nodes: readonly DagNodeOptions[], signal?: AbortSignal) {
    const handles = await tasks.runDag(ctx.cwd, join(ctx.cwd, CONFIG_DIR_NAME, "tasks"), nodes, signal);
    for (const handle of handles) {
      taskNames.set(handle.task.id, handle.task.name);
    }
    for (const handle of handles) {
      trackHandle(ctx, handle);
    }
    return handles.map(({ key, task }) => ({ key, task }));
  }

  async function handleStart(ctx: ExtensionContext, started: Promise<RunningTask | undefined>) {
    try {
      const running = await started;
      if (!running || shuttingDown) {
        return;
      }
      if (jobs.get(running.id)?.status === "queued") {
        jobs.set(running.id, attachAfterNames(running, taskNames));
        updateFooter(ctx.ui);
      }
    } catch {
      // Launch errors are delivered through handleCompletion.
    }
  }

  async function handleCompletion(ctx: ExtensionContext, done: Promise<Result>) {
    try {
      const result = await done;
      if (shuttingDown) {
        return;
      }
      if (recordFinishedJob(jobs, finishedIds, result, taskNames)) {
        updateFooter(ctx.ui);
      }
      if (!result.notifyOnCompletion) {
        return;
      }
      sendCompletion(pi, ctx, result, taskNames);
    } catch (error) {
      if (!shuttingDown) {
        ctx.ui.notify(`Background task completion error: ${String(error)}`, "error");
      }
    }
  }

  async function shutdown(reason: string, ctx: ExtensionContext) {
    shuttingDown = true;
    jobs.clear();
    taskNames.clear();
    finishedIds.length = 0;
    if (ctx.mode === "tui") {
      updateFooter(ctx.ui);
    }
    await tasks.shutdown(`Pi session ended (${reason})`);
  }

  return { jobs, taskNames, tasks, startTask, startDag, shutdown };
}

function sendCompletion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  result: Result,
  taskNames: ReadonlyMap<string, string>,
) {
  const exitPart = result.exitCode == null || result.exitCode === 0 ? "" : ` · exit ${result.exitCode}`;
  const durationPart = result.startedAt ? ` · ${formatDuration(result.startedAt, result.finishedAt)}` : "";
  const lines = [
    `<${notificationType}>`,
    `${statusGlyph(result.status)} ${inlineText(result.name)} (${result.id}) · ${result.status}${exitPart}${durationPart}`,
  ];
  if (result.after?.length) {
    lines.push(`After:  ${result.after.map((id) => formatDependency(id, taskNames)).join(", ")}`);
  }
  if (result.error) {
    lines.push(`Error:  ${inlineText(result.error)}`);
  }
  if (ctx.mode === "tui") {
    lines.push(`View:   /bg-tasks ${result.id}`);
  }
  lines.push(
    `Log:    ${displayPath(result.cwd, result.outputPath)}`,
    result.metadataError
      ? `Result: ${inlineText(result.metadataError)}`
      : `Result: ${displayPath(result.cwd, result.resultPath)}`,
    `</${notificationType}>`,
  );
  pi.sendMessage(
    {
      customType: notificationType,
      display: true,
      details: { task: result },
      content: lines.join("\n"),
    },
    { deliverAs: "followUp", triggerTurn: result.triggerOnCompletion },
  );
}

function statusRank(status: PanelTask["status"]): number {
  if (status === "running") {
    return 0;
  }
  if (status === "queued") {
    return 1;
  }
  return 2;
}

function registerPanel(pi: ExtensionAPI, { jobs, tasks }: ReturnType<typeof createSession>) {
  const listJobs = () => [...jobs.values()].reverse().sort((a, b) => statusRank(a.status) - statusRank(b.status));

  async function stopFromPanel(id: string) {
    await tasks.stop(id, "Stopped from /bg-tasks");
  }

  pi.registerCommand("bg-tasks", {
    description: "Pick a background job, follow its output, or stop it",
    getArgumentCompletions(prefix) {
      const query = prefix.trim().toLowerCase();
      return listJobs()
        .filter((job) => job.id.startsWith(query) || job.name.toLowerCase().includes(query))
        .map((job) => ({
          value: job.id,
          label: plainText(job.name),
          description: `${job.status} · ${job.id}`,
        }));
    },
    async handler(args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/bg-tasks requires interactive Pi. Use the log path returned by bg_run.", "warning");
        return;
      }
      const initialId = args.trim();
      if (initialId && !jobs.has(initialId)) {
        ctx.ui.notify("Task not found in this Pi session. Use /bg-tasks to see available jobs.", "warning");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, keys, done) =>
          createTaskPanel(tui, keys, done, listJobs, stopFromPanel, initialId || undefined, theme),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "90%",
            minWidth: 60,
            maxHeight: "80%",
            margin: { left: 1, right: 1 },
          },
        },
      );
    },
  });
}

function completionGuidance(task: { triggerOnCompletion: boolean; notifyOnCompletion: boolean }) {
  if (task.triggerOnCompletion) {
    return "Pi will follow up on completion; do not poll or sleep to wait.";
  }
  return task.notifyOnCompletion ? "Notification only (no follow-up turn)." : "Completion notifications are disabled.";
}

function formatLiveTask(task: LiveTask, taskNames: ReadonlyMap<string, string>): string {
  const formatDeps = (ids: string[]) => ids.map((id) => formatDependency(id, taskNames)).join(", ");
  const headerDetail =
    task.status === "queued" ? `queued · after ${formatDeps(task.after)}` : `running · PID ${task.pid}`;
  const lines = [`${statusGlyph(task.status)} ${inlineText(task.name)} (${task.id}) · ${headerDetail}`];
  if (task.status === "running" && task.after?.length) {
    lines.push(`  After:  ${formatDeps(task.after)}`);
  }
  lines.push(
    `  Log:    ${displayPath(task.cwd, task.outputPath)}`,
    `  Result: ${displayPath(task.cwd, task.resultPath)}`,
    completionGuidance(task),
  );
  return lines.join("\n");
}

function formatDagSummary(
  scheduled: { key: string; task: LiveTask }[],
  taskNames: ReadonlyMap<string, string>,
): string {
  const noun = scheduled.length === 1 ? "task" : "tasks";
  const lines = [
    `Scheduled ${scheduled.length} ${noun} (files in ${CONFIG_DIR_NAME}/tasks/<id>/output.log and result.json):`,
  ];
  const entries = scheduled.map(({ key, task }) => {
    const label = key === task.name ? inlineText(task.name) : `${inlineText(key)} -> ${inlineText(task.name)}`;
    return { label, task };
  });
  const nameWidth = Math.min(32, Math.max(...entries.map((entry) => entry.label.length)));
  for (const { label, task } of entries) {
    const detail =
      task.status === "queued"
        ? `after ${task.after.map((id) => formatDependency(id, taskNames)).join(", ")}`
        : `PID ${task.pid}`;
    lines.push(
      `  ${statusGlyph(task.status)} ${label.padEnd(nameWidth)}  (${task.id})  ${task.status.padEnd(7)} · ${detail}`,
    );
  }
  const hasTrigger = scheduled.some(({ task }) => task.triggerOnCompletion);
  if (hasTrigger) {
    lines.push("", "Pi will follow up on completion; do not poll or sleep to wait.");
  }
  return lines.join("\n");
}

const commonTaskFields = {
  name: Type.String({
    minLength: 1,
    maxLength: 120,
    description: "Short human-readable name for the job",
  }),
  command: Type.String({
    minLength: 1,
    description: "Command to run with Bash -c",
  }),
  description: Type.Optional(
    Type.String({
      description: "Additional context to include in the result file",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      maximum: MAX_TIMEOUT_SECONDS,
      description: "Stop and fail the task after this many seconds once running; omit for no timeout",
    }),
  ),
  notifyOnCompletion: Type.Optional(
    Type.Boolean({
      description: "Send a completion notification (default true)",
    }),
  ),
  triggerOnCompletion: Type.Optional(
    Type.Boolean({
      description: "Start a follow-up turn on completion (default true; requires notifications)",
    }),
  ),
};

function registerRunTool(pi: ExtensionAPI, { startTask, taskNames }: ReturnType<typeof createSession>) {
  pi.registerTool({
    name: "bg_run",
    label: "Background Bash",
    description:
      "Start or schedule a named Bash command in the project directory and return immediately with its task ID and log path. Pass after with previous task IDs to wait until those tasks finish before starting (even if any failed). By default Pi delivers a completion notification and follows up automatically. Combined stdout and stderr are capped at 20 MiB on disk and never included in the notification.",
    promptSnippet: "Run or schedule long-lived Bash commands without blocking the turn.",
    promptGuidelines: [
      "Use bg_run for long-running builds, tests, and servers. Run the command directly without & or nohup.",
      "Use bg_run with after to schedule a job after existing task IDs, or bg_run_dag to submit a multi-step DAG in one call.",
      "After a bg_run launch with default completion settings, do not sleep or poll. Continue independent work or end the turn; Pi will follow up when the job exits.",
      "Read the bg_run output file only when the command output is needed.",
    ],
    parameters: Type.Object(
      {
        ...commonTaskFields,
        after: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), {
            description:
              "Previous task IDs to wait for before starting this job. Starts once all listed tasks finish, even if any failed.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, options, signal, _onUpdate, ctx) {
      const task = await startTask(ctx, options, signal);
      const content = [{ type: "text" as const, text: formatLiveTask(task, taskNames) }];
      return { content, details: { task } };
    },
  });
}

function registerDagTool(pi: ExtensionAPI, { startDag, taskNames }: ReturnType<typeof createSession>) {
  const dagNodeSchema = Type.Object(
    {
      key: Type.String({
        minLength: 1,
        maxLength: 120,
        description: "Unique identifier for this task within the DAG, referenced by other tasks' after arrays",
      }),
      ...commonTaskFields,
      after: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description:
            "DAG task keys or existing task IDs to wait for before starting. Starts once all finish, even if any failed.",
        }),
      ),
    },
    { additionalProperties: false },
  );

  pi.registerTool({
    name: "bg_run_dag",
    label: "Background Bash DAG",
    description:
      "Schedule a DAG of named Bash commands in the project directory in one call. Tasks with no unfinished dependencies start immediately; dependent tasks wait until all listed dependencies finish (even if any failed). Rejects cycles and unknown dependencies before starting any task.",
    promptSnippet: "Schedule a DAG of dependent background Bash commands in one call.",
    promptGuidelines: [
      "Use bg_run_dag to submit multiple dependent background tasks in one call instead of waiting for task IDs across turns.",
      "In bg_run_dag, after entries can reference keys from the same call or existing task IDs from this session.",
      "Set triggerOnCompletion: false on intermediate DAG tasks when you only need a follow-up after the final task completes.",
    ],
    parameters: Type.Object(
      {
        tasks: Type.Array(dagNodeSchema, {
          minItems: 1,
          description: "Tasks forming an acyclic dependency graph",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, options, signal, _onUpdate, ctx) {
      const scheduled = await startDag(ctx, options.tasks, signal);
      const content = [{ type: "text" as const, text: formatDagSummary(scheduled, taskNames) }];
      const tasks = scheduled.map(({ key, task }) => ({ key, ...task }));
      return { content, details: { tasks } };
    },
  });
}

function stripNotificationTags(content: string | { type: string; text?: string }[]): string[] {
  const raw =
    typeof content === "string"
      ? content
      : content
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text!)
          .join("\n");
  const lines = raw.split("\n");
  if (lines[0] === `<${notificationType}>`) {
    lines.shift();
  }
  if (lines.at(-1) === `</${notificationType}>`) {
    lines.pop();
  }
  return lines;
}

function statusThemeColor(status: Result["status"]): "success" | "error" | "muted" {
  if (status === "completed") {
    return "success";
  }
  if (status === "failed") {
    return "error";
  }
  return "muted";
}

function formatNotificationLine(
  line: string,
  status: Result["status"] | undefined,
  index: number,
  theme: Theme,
): string {
  if (index === 0) {
    const glyph = line.slice(0, 1);
    const rest = line.slice(1);
    if (status && ["✓", "✗", "■"].includes(glyph)) {
      return `${theme.fg(statusThemeColor(status), glyph)}${theme.bold(theme.fg("customMessageText", rest))}`;
    }
    return theme.bold(theme.fg("customMessageText", line));
  }
  const match = /^(After|Error|View|Log|Result):(\s+)(.*)$/.exec(line);
  if (!match) {
    return theme.fg("customMessageText", line);
  }
  const [, key, space, value] = match;
  const label = theme.fg("muted", `${key}:`);
  const valueColor = key === "Error" ? "error" : "customMessageText";
  return `${label}${space}${theme.fg(valueColor, value)}`;
}

function renderNotificationMessage(
  content: string | { type: string; text?: string }[],
  status: Result["status"] | undefined,
  outputPad: number,
  theme: Theme,
): Box {
  const lines = stripNotificationTags(content);
  const styled = lines.map((line, index) => formatNotificationLine(line, status, index, theme)).join("\n");
  const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(styled, 0, 0));
  return box;
}

function registerNotificationRenderer(pi: ExtensionAPI) {
  pi.registerMessageRenderer<{ task?: Result }>(notificationType, (message, options, theme) =>
    renderNotificationMessage(message.content, message.details?.task?.status, options.outputPad, theme),
  );
}

export default function (pi: ExtensionAPI) {
  const session = createSession(pi);
  pi.on("session_shutdown", ({ reason }, ctx) => session.shutdown(reason, ctx));
  registerNotificationRenderer(pi);
  registerPanel(pi, session);
  registerRunTool(pi, session);
  registerDagTool(pi, session);
}
