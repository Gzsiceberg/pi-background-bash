import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  LOG_REFRESH_MS,
  plainText,
  readLogTail,
  type LogTail,
} from "./log-tail.ts";
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

export function createTaskPanel(
  tui: Pick<TUI, "terminal" | "requestRender">,
  keys: Pick<KeybindingsManager, "matches">,
  close: () => void,
  getTasks: () => PanelTask[],
  stopTask: (id: string) => Promise<void>,
  initialId?: string,
): Component & { dispose(): void } {
  let tasks: PanelTask[] = [];
  let selectedId = initialId;
  const current = () => tasks.find((task) => task.id === selectedId);
  let preview: LogTail = { lines: [], clipped: false };
  let loaded: PanelTask | undefined;
  let reading = false;
  let disposed = false;
  let confirmId: string | undefined;
  const stopping = new Set<string>();
  let stopError: { id: string; message: string } | undefined;
  let scrollBack: number | undefined;
  let previewRows = MAX_PREVIEW_ROWS;
  let pathOffset: number | undefined;
  let pathPage = { size: 1, lastStart: 0 };

  function select(id: string | undefined) {
    selectedId = id;
    loaded = undefined;
    scrollBack = undefined;
    pathOffset = undefined;
    confirmId = undefined;
  }

  async function refresh() {
    if (disposed) {
      return;
    }
    const next = getTasks();
    const changed =
      next.length !== tasks.length || next.some((task, i) => task !== tasks[i]);
    if (changed) {
      tasks = next;
      if (!current()) {
        select(tasks[0]?.id);
      }
      if (current()?.status !== "running") {
        confirmId = undefined;
      }
      tui.requestRender();
    }
    const task = current();
    if (
      reading ||
      !task ||
      scrollBack !== undefined ||
      pathOffset !== undefined ||
      (task === loaded && task.status !== "running")
    ) {
      return;
    }
    reading = true;
    try {
      const tail = await readLogTail(
        task.outputPath,
        TAIL_BYTES,
        TAIL_LINES,
      ).catch(() => ({ lines: ["(output log unavailable)"], clipped: false }));
      if (!disposed && task === current() && scrollBack === undefined) {
        const changed =
          task !== loaded ||
          preview.clipped !== tail.clipped ||
          preview.lines.length !== tail.lines.length ||
          preview.lines.some((line, i) => line !== tail.lines[i]);
        loaded = task;
        preview = tail;
        if (changed) {
          tui.requestRender();
        }
      }
    } finally {
      reading = false;
    }
  }

  async function stopSelected(id: string) {
    stopping.add(id);
    stopError = undefined;
    tui.requestRender();
    try {
      await stopTask(id);
    } catch (error) {
      stopError = { id, message: `Stop failed: ${plainText(String(error))}` };
    } finally {
      stopping.delete(id);
      if (!disposed) {
        tui.requestRender();
        void refresh();
      }
    }
  }

  const timer = setInterval(() => void refresh(), LOG_REFRESH_MS);
  timer.unref();
  void refresh();

  return {
    render(width) {
      if (width <= 0) {
        return [];
      }
      const height = Math.max(1, Math.floor(tui.terminal.rows * 0.8));
      const framed = width >= 3 && height >= 5;
      const rows = height - (framed ? 2 : 0);
      const textWidth = width - (framed ? 2 : 0);
      const task = current();
      const body: string[] = [];
      const canStop = task?.status === "running" && !stopping.has(task.id);
      const index = task ? tasks.indexOf(task) : 0;

      if (task && pathOffset !== undefined) {
        if (rows >= 3) {
          body.push("Log path");
        }
        const size = Math.max(1, rows - body.length - 1);
        const lines = wrapTextWithAnsi(plainText(task.outputPath), textWidth);
        const lastStart = Math.max(0, lines.length - size);
        pathPage = { size, lastStart };
        const start = Math.min(pathOffset, lastStart);
        if (rows > 1) {
          body.push(...lines.slice(start, start + size));
        }
        body.push(`Esc/p back${lastStart > 0 ? " · PgUp/PgDn scroll" : ""}`);
      } else if (task) {
        const paused = scrollBack !== undefined;
        const mode = paused
          ? "PAUSED"
          : task.status === "running"
            ? "LIVE"
            : "FINAL";
        if (rows > 1) {
          const jobRows = Math.min(
            tasks.length,
            MAX_JOB_ROWS,
            Math.max(1, Math.floor((rows - 4) / 2)),
          );
          const first = Math.min(
            Math.max(0, index - Math.floor(jobRows / 2)),
            tasks.length - jobRows,
          );
          for (const job of tasks.slice(first, first + jobRows)) {
            const selected = job === task;
            const status =
              job.status === "running" && stopping.has(job.id)
                ? "stopping"
                : job.status;
            const exit =
              job.exitCode == null || job.exitCode === 0
                ? ""
                : ` · exit ${job.exitCode}`;
            body.push(
              `${selected ? "›" : " "} [${status}] ${plainText(job.name)}${exit}`,
            );
          }
        }
        const warning =
          stopError?.id === task.id
            ? stopError.message
            : task.status === "failed" &&
                task.error !== `Bash exited with code ${task.exitCode}`
              ? task.error
              : undefined;
        if (warning && rows - body.length >= 4) {
          body.push(plainText(warning));
        }
        const logRows = rows - body.length - 1;
        const tail = loaded?.id === task.id ? preview : undefined;
        const lines = tail?.lines.length
          ? tail.lines
          : [
              task.status === "running"
                ? "(waiting for output)"
                : "(no output)",
            ];
        previewRows = Math.max(1, Math.min(MAX_PREVIEW_ROWS, logRows - 1));
        const maxBack = Math.max(0, lines.length - previewRows);
        const start = maxBack - Math.min(maxBack, scrollBack ?? 0);
        const end = Math.min(lines.length, start + previewRows);
        const clipped = tail?.clipped || start > 0 || end < lines.length;
        if (logRows > 1) {
          body.push(`${mode}${clipped ? " · Output clipped" : ""}`);
          body.push(...lines.slice(start, end));
        } else if (logRows === 1) {
          body.push(`${mode} ${clipped ? "… " : "· "}${lines[start]}`);
        }
        body.push(
          confirmId
            ? "Stop job? y stop · Esc/n cancel"
            : [
                "Esc close",
                ...(tasks.length > 1 ? ["↑/↓ jobs"] : []),
                ...(canStop ? ["x stop"] : []),
                "p path",
                "PgUp/PgDn scroll",
                ...(paused ? ["End resume"] : []),
              ].join(" · "),
        );
      } else {
        if (rows >= 2) {
          body.push("No background tasks yet.");
        }
        if (rows >= 3) {
          body.push("Ask Pi to run your tests in the background.");
        }
        body.push("Esc close");
      }

      if (!framed) {
        return body.map((line) => truncateToWidth(line, width));
      }
      const border = "─".repeat(textWidth);
      return [
        `╭${border}╮`,
        ...body.map(
          (line) => `│${truncateToWidth(line, textWidth, "…", true)}│`,
        ),
        `╰${border}╯`,
      ];
    },
    handleInput(data) {
      if (disposed) {
        return;
      }
      const cancel =
        matchesKey(data, "escape") || keys.matches(data, "tui.select.cancel");
      const pathKey = matchesKey(data, "p");
      const pageUp = matchesKey(data, "pageUp");
      const pageDown = matchesKey(data, "pageDown");
      const end = matchesKey(data, "end");
      if (pathOffset !== undefined) {
        const start = Math.min(pathOffset, pathPage.lastStart);
        if (cancel || pathKey) {
          pathOffset = undefined;
        } else if (pageUp) {
          pathOffset = Math.max(0, start - pathPage.size);
        } else if (pageDown) {
          pathOffset = Math.min(pathPage.lastStart, start + pathPage.size);
        } else if (end) {
          pathOffset = pathPage.lastStart;
        } else if (matchesKey(data, "home")) {
          pathOffset = 0;
        } else {
          return;
        }
      } else if (confirmId) {
        if (matchesKey(data, "y")) {
          const id = confirmId;
          confirmId = undefined;
          void stopSelected(id);
          return;
        }
        if (!cancel && !matchesKey(data, "n")) {
          return;
        }
        confirmId = undefined;
      } else {
        if (cancel) {
          close();
          return;
        }
        const task = current();
        if (!task) {
          return;
        }
        if (
          matchesKey(data, "x") &&
          task.status === "running" &&
          !stopping.has(task.id)
        ) {
          confirmId = task.id;
        } else if (pathKey) {
          pathOffset = 0;
        } else if (pageUp && loaded?.id === task.id && preview.lines.length) {
          scrollBack = Math.min(
            Math.max(0, preview.lines.length - previewRows),
            (scrollBack ?? 0) + previewRows,
          );
        } else if (pageDown && scrollBack !== undefined) {
          scrollBack = Math.max(0, scrollBack - previewRows);
        } else if (end) {
          scrollBack = undefined;
        } else {
          const offset = keys.matches(data, "tui.select.up")
            ? -1
            : keys.matches(data, "tui.select.down")
              ? 1
              : 0;
          if (offset === 0 || tasks.length < 2) {
            return;
          }
          const index = tasks.indexOf(task);
          select(tasks[(index + offset + tasks.length) % tasks.length].id);
        }
      }
      tui.requestRender();
      void refresh();
    },
    invalidate() {},
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}
