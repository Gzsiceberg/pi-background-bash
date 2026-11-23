import { copyToClipboard, type KeybindingsManager, type Theme, type ThemeBg } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  truncateToWidth,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { LOG_REFRESH_MS, type LogTail, plainText, readLogTail } from "./log-tail.ts";
import { formatDuration } from "./task-presentation.ts";

const TAIL_BYTES = 128 * 1024;
const TAIL_LINES = 2000;
const MAX_JOB_ROWS = 5;
const MAX_COMMAND_ROWS = 6;
const MIN_PREVIEW_ROWS = 2;
const COPY_NOTICE_MS = 2000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸"] as const;

export interface PanelTask {
  id: string;
  name: string;
  command?: string;
  outputPath: string;
  status: "queued" | "running" | "completed" | "failed" | "killed";
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  after?: string[];
  afterNames?: Record<string, string>;
  error?: string;
  exitCode?: number | null;
}

function isStoppableStatus(status: PanelTask["status"] | undefined): boolean {
  return status === "running" || status === "queued";
}

export type PanelTheme = Pick<Theme, "fg" | "bg" | "bold">;

type PanelTui = Pick<TUI, "terminal" | "requestRender">;
type PanelKeys = Pick<KeybindingsManager, "matches">;
type BodyRow = { kind: "line"; text: string; bg?: ThemeBg } | { kind: "divider" };

const plainTheme: PanelTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function lineRow(text: string, bg?: ThemeBg): BodyRow {
  return bg ? { kind: "line", text, bg } : { kind: "line", text };
}

function splitRow(left: string, right: string, width: number): string {
  if (!right) {
    return truncateToWidth(left, width);
  }
  const rightWidth = visibleWidth(right);
  if (rightWidth + 2 >= width) {
    return truncateToWidth(left, width);
  }
  const fittedLeft = truncateToWidth(left, width - rightWidth - 1, "…", true);
  return `${fittedLeft} ${right}`;
}

function topBorder(title: string, innerWidth: number, theme: PanelTheme): string {
  if (!title || innerWidth < 4) {
    return theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
  }
  const fitted = truncateToWidth(title, innerWidth - 3, "…");
  const fill = Math.max(0, innerWidth - visibleWidth(fitted) - 3);
  const left = theme.fg("border", "╭─ ");
  const right = theme.fg("border", ` ${"─".repeat(fill)}╮`);
  return `${left}${fitted}${right}`;
}

function frame(body: BodyRow[], width: number, framed: boolean, title: string, theme: PanelTheme): string[] {
  if (!framed) {
    const rule = theme.fg("borderMuted", "─".repeat(width));
    return body.map((row) => (row.kind === "divider" ? rule : truncateToWidth(row.text, width)));
  }
  const innerWidth = width - 2;
  const padded = innerWidth >= 6;
  const contentWidth = padded ? innerWidth - 2 : innerWidth;
  const border = theme.fg("border", "│");
  const divider = `${theme.fg("border", "├")}${theme.fg("borderMuted", "─".repeat(innerWidth))}${theme.fg("border", "┤")}`;
  const lines = body.map((row) => {
    if (row.kind === "divider") {
      return divider;
    }
    const fitted = truncateToWidth(row.text, contentWidth, "…", true);
    const inner = padded ? ` ${fitted} ` : fitted;
    const styled = row.bg ? theme.bg(row.bg, inner) : inner;
    return `${border}${styled}${border}`;
  });
  return [topBorder(title, innerWidth, theme), ...lines, theme.fg("border", `╰${"─".repeat(innerWidth)}╯`)];
}

function formatHint(theme: PanelTheme, key: string, label: string): string {
  return `${theme.fg("muted", key)} ${theme.fg("dim", label)}`;
}

function joinHints(theme: PanelTheme, hints: string[]): string {
  return hints.join(theme.fg("dim", " · "));
}

function emptyPanel(rows: number, theme: PanelTheme): BodyRow[] {
  const body: BodyRow[] = [];
  if (rows >= 2) {
    body.push(lineRow(theme.fg("muted", "No background tasks yet.")));
  }
  if (rows >= 3) {
    body.push(lineRow(theme.fg("dim", "Ask Pi to run your tests in the background.")));
  }
  if (rows >= 4) {
    body.push({ kind: "divider" });
  }
  body.push(lineRow(formatHint(theme, "Esc", "close")));
  return body;
}

function wrapCommandLines(command: string, textWidth: number, maxRows: number): { lines: string[]; overflow?: string } {
  const normalized = command.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/\n+$/, "");
  const wrapped: string[] = [];
  for (const rawLine of normalized.split("\n")) {
    const pieces = wrapTextWithAnsi(plainText(rawLine), textWidth);
    if (pieces.length > 0) {
      wrapped.push(...pieces);
    } else {
      wrapped.push("");
    }
  }
  if (wrapped.length <= maxRows) {
    return { lines: wrapped };
  }
  if (maxRows === 1) {
    const first = wrapped[0];
    const clipped = visibleWidth(first) >= textWidth ? truncateToWidth(first, textWidth, "…") : `${first}…`;
    return { lines: [clipped] };
  }
  const shown = wrapped.slice(0, maxRows - 1);
  const hidden = wrapped.length - shown.length;
  const noun = hidden === 1 ? "line" : "lines";
  return { lines: shown, overflow: `… (${hidden} more ${noun})` };
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
  private copyNotice?: { id: string; ok: boolean; text: string };
  private copyNoticeTimer?: NodeJS.Timeout;
  private copySeq = 0;
  private scrollBack?: number;
  private previewRows = 12;
  private expanded = false;
  private pathOffset?: number;
  private pathPage = { size: 1, lastStart: 0 };
  private jobRowLayout: { startY: number; ids: (string | undefined)[] } = { startY: 0, ids: [] };
  private spinnerFrame = 0;
  private readonly timer: NodeJS.Timeout;
  private readonly tui: PanelTui;
  private readonly keys: PanelKeys;
  private readonly close: () => void;
  private readonly getTasks: () => PanelTask[];
  private readonly stopTask: (id: string) => Promise<void>;
  private readonly theme: PanelTheme;
  private readonly copyText: (text: string) => Promise<void>;

  constructor(
    tui: PanelTui,
    keys: PanelKeys,
    close: () => void,
    getTasks: () => PanelTask[],
    stopTask: (id: string) => Promise<void>,
    initialId?: string,
    theme: PanelTheme = plainTheme,
    copyText: (text: string) => Promise<void> = copyToClipboard,
  ) {
    this.tui = tui;
    this.keys = keys;
    this.close = close;
    this.getTasks = getTasks;
    this.stopTask = stopTask;
    this.selectedId = initialId;
    this.theme = theme;
    this.copyText = copyText;
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
    this.expanded = false;
    this.pathOffset = undefined;
    this.confirmId = undefined;
    this.clearCopyNotice();
  }

  private clearCopyNotice() {
    clearTimeout(this.copyNoticeTimer);
    this.copyNoticeTimer = undefined;
    this.copyNotice = undefined;
  }

  private showCopyNotice(id: string, ok: boolean, text: string) {
    clearTimeout(this.copyNoticeTimer);
    this.copyNotice = { id, ok, text };
    this.copyNoticeTimer = setTimeout(() => {
      if (!this.disposed && this.copyNotice?.id === id) {
        this.clearCopyNotice();
        this.tui.requestRender();
      }
    }, COPY_NOTICE_MS);
    this.copyNoticeTimer.unref();
    this.tui.requestRender();
  }

  private async copySelectedCommand(task: PanelTask) {
    const command = task.command;
    if (!command?.trim()) {
      return;
    }
    const seq = ++this.copySeq;
    try {
      await this.copyText(command);
      if (!this.disposed && this.copySeq === seq && this.current()?.id === task.id) {
        this.showCopyNotice(task.id, true, "Copied command");
      }
    } catch (error) {
      if (!this.disposed && this.copySeq === seq && this.current()?.id === task.id) {
        const reason = error instanceof Error ? error.message : String(error);
        this.showCopyNotice(task.id, false, `Copy failed: ${plainText(reason)}`);
      }
    }
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
    if (!isStoppableStatus(this.current()?.status)) {
      this.confirmId = undefined;
    }
    if (!this.canExpand(this.current())) {
      this.expanded = false;
    }
    this.tui.requestRender();
  }

  private tickSpinner() {
    if (this.pathOffset !== undefined || !this.tasks.some((task) => task.status === "running")) {
      return;
    }
    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
    this.tui.requestRender();
  }

  private async refresh() {
    if (this.disposed) {
      return;
    }
    this.updateTasks();
    this.tickSpinner();
    const task = this.current();
    if (task?.status === "queued") {
      this.loaded = undefined;
      return;
    }
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
    const innerWidth = framed ? width - 2 : width;
    const contentWidth = framed && innerWidth >= 6 ? innerWidth - 2 : innerWidth;
    const task = this.current();
    if (!task) {
      this.jobRowLayout = { startY: 0, ids: [] };
      const title = this.theme.bold(this.theme.fg("toolTitle", "Background Tasks"));
      return frame(emptyPanel(rows, this.theme), width, framed, title, this.theme);
    }
    if (this.pathOffset !== undefined) {
      this.jobRowLayout = { startY: 0, ids: [] };
      const title = this.pathTitle(task);
      const body = this.renderPath(task, rows, contentWidth, this.pathOffset, framed);
      return frame(body, width, framed, title, this.theme);
    }
    const title = this.jobsTitle(task);
    const body = this.renderJob(task, rows, contentWidth, framed ? 1 : 0);
    return frame(body, width, framed, title, this.theme);
  }

  private jobsTitle(task: PanelTask): string {
    const running = this.tasks.filter((job) => job.status === "running").length;
    const queued = this.tasks.filter((job) => job.status === "queued").length;
    const activeParts: string[] = [];
    if (running > 0) {
      activeParts.push(`${running} running`);
    }
    if (queued > 0) {
      activeParts.push(`${queued} queued`);
    }
    const summary = activeParts.length > 0 ? activeParts.join(", ") : `${this.tasks.length} finished`;
    const parts = [this.theme.bold(this.theme.fg("toolTitle", "Background Tasks")), this.theme.fg("muted", summary)];
    if (this.tasks.length > MAX_JOB_ROWS) {
      parts.push(this.theme.fg("dim", `${this.tasks.indexOf(task) + 1}/${this.tasks.length}`));
    }
    return parts.join(this.theme.fg("dim", " · "));
  }

  private pathTitle(task: PanelTask): string {
    const heading = this.theme.bold(this.theme.fg("toolTitle", "Log path"));
    const name = this.theme.fg("muted", plainText(task.name));
    return `${heading}${this.theme.fg("dim", " · ")}${name}`;
  }

  private renderPath(task: PanelTask, rows: number, width: number, offset: number, framed: boolean): BodyRow[] {
    const body: BodyRow[] = [];
    if (!framed && rows >= 3) {
      body.push(lineRow(this.theme.bold(this.theme.fg("toolTitle", "Log path"))));
    }
    const showDivider = rows - body.length >= 3;
    const footerRows = showDivider ? 2 : 1;
    const size = Math.max(1, rows - body.length - footerRows);
    const lines = wrapTextWithAnsi(plainText(task.outputPath), Math.max(1, width));
    const lastStart = Math.max(0, lines.length - size);
    this.pathPage = { size, lastStart };
    const start = Math.min(offset, lastStart);
    if (rows > 1) {
      for (const line of lines.slice(start, start + size)) {
        body.push(lineRow(this.theme.fg("toolOutput", line)));
      }
    }
    if (showDivider) {
      body.push({ kind: "divider" });
    }
    const hints = [formatHint(this.theme, "Esc/p", "back")];
    if (lastStart > 0) {
      hints.push(formatHint(this.theme, "PgUp/PgDn", "scroll"));
    }
    body.push(lineRow(joinHints(this.theme, hints)));
    return body;
  }

  private canStop(task: PanelTask) {
    return isStoppableStatus(task.status) && !this.stopping.has(task.id);
  }

  private canExpand(task?: PanelTask) {
    return Boolean(task?.command?.trim());
  }

  private statusGlyph(job: PanelTask): string {
    if (job.status === "running") {
      return this.stopping.has(job.id)
        ? this.theme.fg("warning", "◌")
        : this.theme.fg("accent", SPINNER_FRAMES[this.spinnerFrame]);
    }
    if (job.status === "queued") {
      return this.stopping.has(job.id) ? this.theme.fg("warning", "◌") : this.theme.fg("muted", "◷");
    }
    if (job.status === "completed") {
      return this.theme.fg("success", "✓");
    }
    if (job.status === "failed") {
      return this.theme.fg("error", "✗");
    }
    return this.theme.fg("muted", "■");
  }

  private dependencyLabel(job: PanelTask, id: string, maxNameWidth?: number): string {
    const rawName = job.afterNames?.[id] ?? this.tasks.find((item) => item.id === id)?.name;
    if (!rawName) {
      return id;
    }
    const clean = plainText(rawName);
    const label = maxNameWidth === undefined ? clean : truncateToWidth(clean, maxNameWidth, "…");
    return `${label} (${id})`;
  }

  private queuedMeta(job: PanelTask): string {
    if (this.stopping.has(job.id)) {
      return this.theme.fg("warning", "stopping");
    }
    if (job.after?.length === 1) {
      return this.theme.fg("muted", `after ${this.dependencyLabel(job, job.after[0], 24)}`);
    }
    if (job.after && job.after.length > 1) {
      return this.theme.fg("muted", `after ${job.after.length} tasks`);
    }
    return this.theme.fg("muted", "queued");
  }

  private jobMeta(job: PanelTask): string {
    if (job.status === "queued") {
      return this.queuedMeta(job);
    }
    const parts: string[] = [];
    if (job.status === "running" && this.stopping.has(job.id)) {
      parts.push(this.theme.fg("warning", "stopping"));
    } else if (job.status === "killed") {
      parts.push(this.theme.fg("muted", "stopped"));
    } else if (job.exitCode != null && job.exitCode !== 0) {
      parts.push(this.theme.fg("error", `exit ${job.exitCode}`));
    }
    if (job.startedAt) {
      parts.push(this.theme.fg("muted", formatDuration(job.startedAt, job.finishedAt)));
    }
    return parts.join(this.theme.fg("dim", " · "));
  }

  private formatJobRow(job: PanelTask, selected: boolean, expanded: boolean, width: number): BodyRow {
    const marker = expanded ? "▾" : "›";
    const pointer = selected ? this.theme.fg("accent", marker) : " ";
    const glyph = this.statusGlyph(job);
    const rawName = plainText(job.name);
    const nameColor = selected || job.status === "running" ? "text" : "muted";
    const name = selected ? this.theme.bold(this.theme.fg("text", rawName)) : this.theme.fg(nameColor, rawName);
    const left = `${pointer} ${glyph} ${name}`;
    const text = splitRow(left, this.jobMeta(job), width);
    return lineRow(text, selected ? "selectedBg" : undefined);
  }

  private commandRows(task: PanelTask, width: number, maxRows: number): BodyRow[] {
    if (!this.expanded || !task.command?.trim() || maxRows <= 0) {
      return [];
    }
    const useIndent = width >= 6;
    const textWidth = useIndent ? width - 4 : Math.max(1, width);
    const { lines, overflow } = wrapCommandLines(task.command, textWidth, maxRows);
    const indent = useIndent ? "    " : "";
    const rows = lines.map((line) => lineRow(`${indent}${this.theme.fg("toolOutput", line)}`, "selectedBg"));
    if (overflow) {
      rows.push(lineRow(`${indent}${this.theme.fg("dim", overflow)}`, "selectedBg"));
    }
    return rows;
  }

  private jobRows(task: PanelTask, rows: number, width: number, startY: number, reservedRows: number): BodyRow[] {
    if (rows <= 1) {
      this.jobRowLayout = { startY, ids: [] };
      return [];
    }
    const count = Math.min(this.tasks.length, MAX_JOB_ROWS, Math.max(1, Math.floor((rows - 4) / 2)));
    const maxCommandRows = Math.min(MAX_COMMAND_ROWS, Math.max(0, rows - count - reservedRows));
    const index = this.tasks.indexOf(task);
    const first = Math.min(Math.max(0, index - Math.floor(count / 2)), this.tasks.length - count);
    const visible = this.tasks.slice(first, first + count);
    const result: BodyRow[] = [];
    const layoutIds: (string | undefined)[] = [];
    for (const job of visible) {
      const selected = job === task;
      const expandedRows = selected ? this.commandRows(job, width, maxCommandRows) : [];
      result.push(this.formatJobRow(job, selected, expandedRows.length > 0, width));
      layoutIds.push(job.id);
      for (const cmdRow of expandedRows) {
        result.push(cmdRow);
        layoutIds.push(undefined);
      }
    }
    this.jobRowLayout = { startY, ids: layoutIds };
    return result;
  }

  private warning(task: PanelTask) {
    if (this.stopError?.id === task.id) {
      return this.stopError.message;
    }
    if (task.status === "failed" && task.error !== `Bash exited with code ${task.exitCode}`) {
      return task.error;
    }
  }

  private renderJob(task: PanelTask, rows: number, width: number, startY: number): BodyRow[] {
    const showDividers = rows >= 7;
    const footerRows = showDividers ? 2 : 1;
    const warning = this.warning(task);
    const reservedRows = (showDividers ? 1 : 0) + footerRows + (warning ? 1 : 0) + MIN_PREVIEW_ROWS;
    const body = this.jobRows(task, rows, width, startY, reservedRows);
    if (showDividers && body.length > 0) {
      body.push({ kind: "divider" });
    }
    if (warning && rows - body.length - footerRows >= 3) {
      body.push(lineRow(this.theme.fg("error", plainText(warning))));
    }
    body.push(...this.renderPreview(task, rows - body.length - footerRows, width));
    if (showDividers) {
      body.push({ kind: "divider" });
    }
    body.push(lineRow(this.footer(task)));
    return body;
  }

  private footer(task: PanelTask) {
    if (this.confirmId) {
      const prompt = this.theme.bold(this.theme.fg("warning", "Stop job?"));
      const confirm = `${this.theme.fg("error", "y")} ${this.theme.fg("muted", "stop")}`;
      const cancel = formatHint(this.theme, "Esc/n", "cancel");
      return `${prompt}  ${joinHints(this.theme, [confirm, cancel])}`;
    }
    if (this.copyNotice?.id === task.id) {
      return this.copyNotice.ok
        ? this.theme.fg("success", `✓ ${this.copyNotice.text}`)
        : this.theme.fg("error", this.copyNotice.text);
    }
    const hints = [formatHint(this.theme, "Esc", "close")];
    if (this.tasks.length > 1) {
      hints.push(formatHint(this.theme, "↑/↓", "jobs"));
    }
    if (this.canExpand(task)) {
      hints.push(formatHint(this.theme, "Enter", this.expanded ? "hide" : "command"));
      hints.push(formatHint(this.theme, "y", "copy"));
    }
    if (this.canStop(task)) {
      hints.push(formatHint(this.theme, "x", "stop"));
    }
    hints.push(formatHint(this.theme, "p", "path"), formatHint(this.theme, "PgUp/PgDn", "scroll"));
    if (this.scrollBack !== undefined) {
      hints.push(formatHint(this.theme, "End", "resume"));
    }
    return joinHints(this.theme, hints);
  }

  private modeBadge(task: PanelTask): string {
    if (this.scrollBack !== undefined) {
      return this.theme.bold(this.theme.fg("warning", "⏸ PAUSED"));
    }
    if (task.status === "running") {
      return this.theme.bold(this.theme.fg("accent", `${SPINNER_FRAMES[this.spinnerFrame]} LIVE`));
    }
    if (task.status === "queued") {
      return this.theme.fg("muted", "◷ QUEUED");
    }
    return this.theme.fg("muted", "FINAL");
  }

  private previewFallback(task: PanelTask): string {
    if (task.status === "running") {
      return "(waiting for output)";
    }
    if (task.status === "queued") {
      if (!task.after?.length) {
        return "(queued)";
      }
      const deps = task.after.map((id) => this.dependencyLabel(task, id)).join(", ");
      return `(waiting for ${deps} to finish)`;
    }
    return "(no output)";
  }

  private scrollMeta(tail: LogTail | undefined, start: number, end: number, total: number): string {
    if (!tail?.lines.length) {
      return "";
    }
    const scrolled = start > 0 || end < total;
    if (!scrolled && !tail.clipped) {
      return "";
    }
    const suffix = tail.clipped ? "+" : "";
    const label = scrolled ? `lines ${start + 1}–${end} of ${total}${suffix}` : `last ${total} lines (clipped)`;
    return this.theme.fg("muted", label);
  }

  private renderPreview(task: PanelTask, rows: number, width: number): BodyRow[] {
    this.previewRows = Math.max(1, rows - 1);
    if (rows <= 0) {
      return [];
    }
    const badge = this.modeBadge(task);
    const tail = this.loaded?.id === task.id ? this.preview : undefined;
    const hasOutput = Boolean(tail?.lines.length);
    const fallback = this.previewFallback(task);
    const lines = hasOutput ? tail!.lines : [fallback];
    const maxBack = Math.max(0, lines.length - this.previewRows);
    const start = maxBack - Math.min(maxBack, this.scrollBack ?? 0);
    const end = Math.min(lines.length, start + this.previewRows);
    const clipped = (tail?.clipped ?? false) || start > 0 || end < lines.length;
    if (rows === 1) {
      const sep = clipped ? "… " : "· ";
      const line = hasOutput ? this.theme.fg("toolOutput", lines[start]) : this.theme.fg("dim", lines[start]);
      return [lineRow(`${badge} ${sep}${line}`)];
    }
    const header = splitRow(badge, this.scrollMeta(tail, start, end, lines.length), width);
    const output = lines
      .slice(start, end)
      .map((line) => lineRow(hasOutput ? this.theme.fg("toolOutput", line) : this.theme.fg("dim", line)));
    while (output.length < this.previewRows) {
      output.push(lineRow(""));
    }
    return [lineRow(header), ...output];
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
      this.clearCopyNotice();
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
    if (matchesKey(data, "y") && this.canExpand(task)) {
      void this.copySelectedCommand(task);
      return false;
    }
    if ((matchesKey(data, "enter") || this.keys.matches(data, "tui.select.confirm")) && this.canExpand(task)) {
      this.expanded = !this.expanded;
    } else if (matchesKey(data, "x") && this.canStop(task)) {
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
    } else if (matchesKey(data, "home") && this.loaded?.id === task.id && this.preview.lines.length) {
      this.scrollBack = Math.max(0, this.preview.lines.length - this.previewRows);
    } else if (matchesKey(data, "end")) {
      this.scrollBack = undefined;
    } else {
      return this.switchJob(data, task);
    }
    return true;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) {
      return undefined;
    }
    if (event.type === "wheel") {
      return this.handleWheel(Math.trunc(event.wheelDelta ?? 0));
    }
    if (event.type === "press" && event.button === "left") {
      return this.handlePress(event.y);
    }
    return undefined;
  }

  private handleWheel(delta: number): TuiMouseEventResult {
    if (delta === 0 || this.confirmId) {
      return { handled: true, render: false };
    }
    if (this.pathOffset !== undefined) {
      const current = Math.min(this.pathOffset, this.pathPage.lastStart);
      const next = Math.max(0, Math.min(this.pathPage.lastStart, current + delta));
      if (next === current) {
        return { handled: true, render: false };
      }
      this.pathOffset = next;
      return { handled: true };
    }
    return this.scrollPreview(delta);
  }

  private scrollPreview(delta: number): TuiMouseEventResult {
    const task = this.current();
    if (!task || this.loaded?.id !== task.id || !this.preview.lines.length) {
      return { handled: true, render: false };
    }
    const maxBack = Math.max(0, this.preview.lines.length - this.previewRows);
    if (delta < 0) {
      if (maxBack === 0) {
        return { handled: true, render: false };
      }
      const next = Math.min(maxBack, (this.scrollBack ?? 0) - delta);
      if (next === this.scrollBack) {
        return { handled: true, render: false };
      }
      this.scrollBack = next;
      return { handled: true };
    }
    if (this.scrollBack === undefined) {
      return { handled: true, render: false };
    }
    const next = this.scrollBack - delta;
    if (next <= 0) {
      this.scrollBack = undefined;
      void this.refresh();
    } else {
      this.scrollBack = next;
    }
    return { handled: true };
  }

  private handlePress(y: number): TuiMouseEventResult | undefined {
    if (this.confirmId || this.pathOffset !== undefined) {
      return undefined;
    }
    const index = y - this.jobRowLayout.startY;
    const id = index >= 0 ? this.jobRowLayout.ids[index] : undefined;
    if (!id || id === this.selectedId) {
      return undefined;
    }
    this.select(id);
    void this.refresh();
    return { handled: true, focus: true };
  }

  private switchJob(data: string, task: PanelTask) {
    let offset = 0;
    if (this.keys.matches(data, "tui.select.up") || matchesKey(data, "k")) {
      offset = -1;
    } else if (this.keys.matches(data, "tui.select.down") || matchesKey(data, "j")) {
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
    this.clearCopyNotice();
  }
}

export function createTaskPanel(
  tui: PanelTui,
  keys: PanelKeys,
  close: () => void,
  getTasks: () => PanelTask[],
  stopTask: (id: string) => Promise<void>,
  initialId?: string,
  theme?: PanelTheme,
  copyText?: (text: string) => Promise<void>,
): Component & { dispose(): void } {
  return new TaskPanel(tui, keys, close, getTasks, stopTask, initialId, theme, copyText);
}
