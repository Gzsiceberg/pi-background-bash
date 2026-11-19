import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { LOG_REFRESH_MS, type LogTail, plainText, readLogTail } from "./log-tail.ts";

const TAIL_BYTES = 128 * 1024;
const TAIL_LINES = 2000;
const MAX_PREVIEW_ROWS = 12;
const MAX_JOB_ROWS = 5;

export interface PanelTask {
  id: string;
  name: string;
  outputPath: string;
  status: "running" | "completed" | "failed" | "killed";
  error?: string;
  exitCode?: number | null;
}

type PanelTui = Pick<TUI, "terminal" | "requestRender">;
type PanelKeys = Pick<KeybindingsManager, "matches">;

function frame(body: string[], width: number, framed: boolean) {
  if (!framed) {
    return body.map((line) => truncateToWidth(line, width));
  }
  const border = "─".repeat(width);
  return [`╭${border}╮`, ...body.map((line) => `│${truncateToWidth(line, width, "…", true)}│`), `╰${border}╯`];
}

function emptyPanel(rows: number) {
  const body: string[] = [];
  if (rows >= 2) {
    body.push("No background tasks yet.");
  }
  if (rows >= 3) {
    body.push("Ask Pi to run your tests in the background.");
  }
  return [...body, "Esc close"];
}

async function loadTail(path: string): Promise<LogTail> {
  try {
    return await readLogTail(path, TAIL_BYTES, TAIL_LINES);
  } catch {
    return { lines: ["(output log unavailable)"], clipped: false };
  }
}

class TaskPanel implements Component {
  private tasks: PanelTask[] = [];
  private selectedId?: string;
  private preview: LogTail = { lines: [], clipped: false };
  private loaded?: PanelTask;
  private reading = false;
  private disposed = false;
  private confirmId?: string;
  private readonly stopping = new Set<string>();
  private stopError?: { id: string; message: string };
  private scrollBack?: number;
  private previewRows = MAX_PREVIEW_ROWS;
  private pathOffset?: number;
  private pathPage = { size: 1, lastStart: 0 };
  private readonly timer: NodeJS.Timeout;
  private readonly tui: PanelTui;
  private readonly keys: PanelKeys;
  private readonly close: () => void;
  private readonly getTasks: () => PanelTask[];
  private readonly stopTask: (id: string) => Promise<void>;

  constructor(
    tui: PanelTui,
    keys: PanelKeys,
    close: () => void,
    getTasks: () => PanelTask[],
    stopTask: (id: string) => Promise<void>,
    initialId?: string,
  ) {
    this.tui = tui;
    this.keys = keys;
    this.close = close;
    this.getTasks = getTasks;
    this.stopTask = stopTask;
    this.selectedId = initialId;
    this.timer = setInterval(() => void this.refresh(), LOG_REFRESH_MS);
    this.timer.unref();
    void this.refresh();
  }

  private current() {
    return this.tasks.find((task) => task.id === this.selectedId);
  }

  private select(id?: string) {
    this.selectedId = id;
    this.loaded = undefined;
    this.scrollBack = undefined;
    this.pathOffset = undefined;
    this.confirmId = undefined;
  }

  private updateTasks() {
    const next = this.getTasks();
    const changed = next.length !== this.tasks.length || next.some((task, i) => task !== this.tasks[i]);
    if (!changed) {
      return;
    }
    this.tasks = next;
    if (!this.current()) {
      this.select(next[0]?.id);
    }
    if (this.current()?.status !== "running") {
      this.confirmId = undefined;
    }
    this.tui.requestRender();
  }

  private async refresh() {
    if (this.disposed) {
      return;
    }
    this.updateTasks();
    const task = this.current();
    if (
      this.reading ||
      !task ||
      this.scrollBack !== undefined ||
      this.pathOffset !== undefined ||
      (task === this.loaded && task.status !== "running")
    ) {
      return;
    }
    this.reading = true;
    try {
      const tail = await loadTail(task.outputPath);
      if (!this.disposed && task === this.current() && this.scrollBack === undefined) {
        this.updatePreview(task, tail);
      }
    } finally {
      this.reading = false;
    }
  }

  private updatePreview(task: PanelTask, tail: LogTail) {
    const changed =
      task !== this.loaded ||
      this.preview.clipped !== tail.clipped ||
      this.preview.lines.length !== tail.lines.length ||
      this.preview.lines.some((line, i) => line !== tail.lines[i]);
    this.loaded = task;
    this.preview = tail;
    if (changed) {
      this.tui.requestRender();
    }
  }

  private async stopSelected(id: string) {
    this.stopping.add(id);
    this.stopError = undefined;
    this.tui.requestRender();
    try {
      await this.stopTask(id);
    } catch (error) {
      this.stopError = { id, message: `Stop failed: ${plainText(String(error))}` };
    } finally {
      this.stopping.delete(id);
      if (!this.disposed) {
        this.redraw();
      }
    }
  }

  private redraw() {
    this.tui.requestRender();
    void this.refresh();
  }

  render(width: number) {
    if (width <= 0) {
      return [];
    }
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8));
    const framed = width >= 3 && height >= 5;
    const rows = height - (framed ? 2 : 0);
    const textWidth = width - (framed ? 2 : 0);
    const task = this.current();
    if (!task) {
      return frame(emptyPanel(rows), textWidth, framed);
    }
    const body =
      this.pathOffset === undefined
        ? this.renderJob(task, rows)
        : this.renderPath(task, rows, textWidth, this.pathOffset);
    return frame(body, textWidth, framed);
  }

  private renderPath(task: PanelTask, rows: number, width: number, offset: number) {
    const body = rows >= 3 ? ["Log path"] : [];
    const size = Math.max(1, rows - body.length - 1);
    const lines = wrapTextWithAnsi(plainText(task.outputPath), width);
    const lastStart = Math.max(0, lines.length - size);
    this.pathPage = { size, lastStart };
    const start = Math.min(offset, lastStart);
    if (rows > 1) {
      body.push(...lines.slice(start, start + size));
    }
    return [...body, `Esc/p back${lastStart > 0 ? " · PgUp/PgDn scroll" : ""}`];
  }

  private canStop(task: PanelTask) {
    return task.status === "running" && !this.stopping.has(task.id);
  }

  private jobRows(task: PanelTask, rows: number) {
    if (rows <= 1) {
      return [];
    }
    const count = Math.min(this.tasks.length, MAX_JOB_ROWS, Math.max(1, Math.floor((rows - 4) / 2)));
    const index = this.tasks.indexOf(task);
    const first = Math.min(Math.max(0, index - Math.floor(count / 2)), this.tasks.length - count);
    return this.tasks.slice(first, first + count).map((job) => {
      const status = job.status === "running" && this.stopping.has(job.id) ? "stopping" : job.status;
      const exit = job.exitCode == null || job.exitCode === 0 ? "" : ` · exit ${job.exitCode}`;
      return `${job === task ? "›" : " "} [${status}] ${plainText(job.name)}${exit}`;
    });
  }

  private warning(task: PanelTask) {
    if (this.stopError?.id === task.id) {
      return this.stopError.message;
    }
    if (task.status === "failed" && task.error !== `Bash exited with code ${task.exitCode}`) {
      return task.error;
    }
  }

  private renderJob(task: PanelTask, rows: number) {
    const body = this.jobRows(task, rows);
    const warning = this.warning(task);
    if (warning && rows - body.length >= 4) {
      body.push(plainText(warning));
    }
    body.push(...this.renderPreview(task, rows - body.length - 1));
    return [...body, this.footer(task)];
  }

  private footer(task: PanelTask) {
    if (this.confirmId) {
      return "Stop job? y stop · Esc/n cancel";
    }
    const hints = ["Esc close"];
    if (this.tasks.length > 1) {
      hints.push("↑/↓ jobs");
    }
    if (this.canStop(task)) {
      hints.push("x stop");
    }
    hints.push("p path", "PgUp/PgDn scroll");
    if (this.scrollBack !== undefined) {
      hints.push("End resume");
    }
    return hints.join(" · ");
  }

  private renderPreview(task: PanelTask, rows: number) {
    this.previewRows = Math.max(1, Math.min(MAX_PREVIEW_ROWS, rows - 1));
    if (rows <= 0) {
      return [];
    }
    const live = task.status === "running";
    const mode = this.scrollBack !== undefined ? "PAUSED" : this.followMode(live);
    const tail = this.loaded?.id === task.id ? this.preview : undefined;
    const fallback = live ? "(waiting for output)" : "(no output)";
    const lines = tail?.lines.length ? tail.lines : [fallback];
    const maxBack = Math.max(0, lines.length - this.previewRows);
    const start = maxBack - Math.min(maxBack, this.scrollBack ?? 0);
    const end = Math.min(lines.length, start + this.previewRows);
    const clipped = (tail?.clipped ?? false) || start > 0 || end < lines.length;
    if (rows === 1) {
      return [`${mode} ${clipped ? "… " : "· "}${lines[start]}`];
    }
    const output = lines.slice(start, end);
    while (output.length < this.previewRows) {
      output.push("");
    }
    return [`${mode}${clipped ? " · Output clipped" : ""}`, ...output];
  }

  private followMode(live: boolean) {
    return live ? "LIVE" : "FINAL";
  }

  handleInput(data: string) {
    if (this.disposed) {
      return;
    }
    const cancel = matchesKey(data, "escape") || this.keys.matches(data, "tui.select.cancel");
    if (this.pathOffset !== undefined) {
      this.handlePathInput(data, cancel, this.pathOffset);
      return;
    }
    if (this.confirmId) {
      this.handleConfirmInput(data, cancel, this.confirmId);
      return;
    }
    if (cancel) {
      this.close();
      return;
    }
    const task = this.current();
    if (task && this.handleJobInput(data, task)) {
      this.redraw();
    }
  }

  private handlePathInput(data: string, cancel: boolean, offset: number) {
    const { size, lastStart } = this.pathPage;
    const start = Math.min(offset, lastStart);
    if (cancel || matchesKey(data, "p")) {
      this.pathOffset = undefined;
    } else if (matchesKey(data, "pageUp")) {
      this.pathOffset = Math.max(0, start - size);
    } else if (matchesKey(data, "pageDown")) {
      this.pathOffset = Math.min(lastStart, start + size);
    } else if (matchesKey(data, "end")) {
      this.pathOffset = lastStart;
    } else if (matchesKey(data, "home")) {
      this.pathOffset = 0;
    } else {
      return;
    }
    this.redraw();
  }

  private handleConfirmInput(data: string, cancel: boolean, id: string) {
    if (matchesKey(data, "y")) {
      this.confirmId = undefined;
      void this.stopSelected(id);
      return;
    }
    if (cancel || matchesKey(data, "n")) {
      this.confirmId = undefined;
      this.redraw();
    }
  }

  private handleJobInput(data: string, task: PanelTask) {
    if (matchesKey(data, "x") && this.canStop(task)) {
      this.confirmId = task.id;
    } else if (matchesKey(data, "p")) {
      this.pathOffset = 0;
    } else if (matchesKey(data, "pageUp") && this.loaded?.id === task.id && this.preview.lines.length) {
      this.scrollBack = Math.min(
        Math.max(0, this.preview.lines.length - this.previewRows),
        (this.scrollBack ?? 0) + this.previewRows,
      );
    } else if (matchesKey(data, "pageDown") && this.scrollBack !== undefined) {
      this.scrollBack = Math.max(0, this.scrollBack - this.previewRows);
    } else if (matchesKey(data, "end")) {
      this.scrollBack = undefined;
    } else {
      return this.switchJob(data, task);
    }
    return true;
  }

  private switchJob(data: string, task: PanelTask) {
    let offset = 0;
    if (this.keys.matches(data, "tui.select.up")) {
      offset = -1;
    } else if (this.keys.matches(data, "tui.select.down")) {
      offset = 1;
    }
    if (offset === 0 || this.tasks.length < 2) {
      return false;
    }
    const index = this.tasks.indexOf(task);
    this.select(this.tasks[(index + offset + this.tasks.length) % this.tasks.length].id);
    return true;
  }

  invalidate() {
    // Rendering reads the current terminal dimensions; there is no layout cache.
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
  }
}

export function createTaskPanel(
  tui: PanelTui,
  keys: PanelKeys,
  close: () => void,
  getTasks: () => PanelTask[],
  stopTask: (id: string) => Promise<void>,
  initialId?: string,
): Component & { dispose(): void } {
  return new TaskPanel(tui, keys, close, getTasks, stopTask, initialId);
}
