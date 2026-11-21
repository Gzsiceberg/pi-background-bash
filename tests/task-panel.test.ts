import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as wait } from "node:timers/promises";

import { matchesKey, stripTerminalSequences, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";

import { createTaskPanel, type PanelTask, type PanelTheme } from "../src/task-panel.ts";

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) {
      return;
    }
    await wait(20);
  }
  assert.fail("Timed out waiting for the task panel to refresh");
}

const posix = { skip: process.platform === "win32", timeout: 10_000 };

async function checkClippingAndStop(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-panel-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const running: PanelTask = {
    id: "run",
    name: "Live build",
    outputPath: join(cwd, "live.log"),
    status: "running",
    startedAt: new Date(Date.now() - 5000).toISOString(),
  };
  const finished: PanelTask = {
    id: "done",
    name: "Old test",
    outputPath: join(cwd, "old.log"),
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:05.000Z",
    exitCode: 0,
  };
  await writeFile(running.outputPath, "first line\n");
  await writeFile(finished.outputPath, "previous output\n");
  let jobs: PanelTask[] = [];
  let renders = 0;
  let closed = false;
  const terminal = { rows: 24 };
  const stopped: string[] = [];
  let finishStop: (() => void) | undefined;
  const keys = {
    matches(data: string, binding: string) {
      if (binding === "tui.select.up") {
        return matchesKey(data, "up");
      }
      if (binding === "tui.select.down") {
        return matchesKey(data, "down");
      }
      return false;
    },
  };
  const panel = createTaskPanel(
    {
      terminal: terminal as Parameters<typeof createTaskPanel>[0]["terminal"],
      requestRender: () => {
        renders++;
      },
    },
    keys,
    () => {
      closed = true;
      panel.dispose?.();
    },
    () => jobs,
    async (id) => {
      stopped.push(id);
      await new Promise<void>((resolve) => {
        finishStop = resolve;
      });
    },
  );
  t.after(() => panel.dispose?.());
  const display = () => panel.render(80).join("\n");
  assert.match(display(), /Background Tasks/);
  assert.match(display(), /No background tasks/);
  assert.match(display(), /Ask Pi to run your tests in the background/);
  jobs = [running, finished];
  await until(() => display().includes("first line"));
  assert.match(display(), /Background Tasks · 1 running/);
  assert.match(display(), /› [⠋⠙⠹⠸] Live build/);
  assert.match(display(), /✓ Old test.*1m 5s/);
  assert.ok(!display().includes("\x1b"));
  assert.doesNotMatch(display(), /live\.log/);
  const initialHeight = panel.render(80).length;

  await appendFile(running.outputPath, "\x1b[31mnew output\x1b[0m\n");
  await until(() => display().includes("new output"));
  assert.ok(
    !display()
      .split("\n")
      .find((line) => line.includes("new output"))!
      .includes("\x1b"),
  );
  assert.ok(panel.render(12).every((line) => visibleWidth(line) <= 12));

  assert.doesNotMatch(display(), /lines \d+–\d+ of/);
  terminal.rows = 4;
  assert.match(display(), /… new output/);
  assert.match(display(), /Esc close/);
  terminal.rows = 24;
  await appendFile(running.outputPath, `${"line\n".repeat(13)}last line\n`);
  await until(() => display().includes("last line"));
  assert.match(display(), /[⠋⠙⠹⠸] LIVE.*lines \d+–16 of 16/);
  assert.doesNotMatch(display(), /first line/);
  assert.equal(panel.render(80).length, initialHeight);

  assert.match(display(), /x stop/);
  panel.handleInput?.("x");
  assert.match(display(), /y stop/);
  panel.handleInput?.("\x1b[A"); // Confirmation keeps the same target.
  panel.handleInput?.("\x1b");
  assert.equal(closed, false);
  assert.deepEqual(stopped, []);
  panel.handleInput?.("x");
  panel.handleInput?.("y");
  assert.deepEqual(stopped, [running.id]);
  assert.match(display(), /› ◌ Live build.*stopping/);
  panel.handleInput?.("x");
  panel.handleInput?.("y");
  assert.deepEqual(stopped, [running.id]);

  jobs = [
    finished,
    {
      ...running,
      status: "killed",
      finishedAt: new Date().toISOString(),
      error: "Stopped from /bg-tasks",
    },
  ];
  assert.ok(finishStop);
  finishStop();
  await until(() => /› ■ Live build.*stopped/.test(display()));
  assert.doesNotMatch(display(), /Stopped from \/bg-tasks/);
  assert.match(display(), /last line/);

  panel.handleInput?.("\x1b[A");
  await until(() => display().includes("previous output"));
  assert.match(display(), /› ✓ Old test/);
  assert.equal(panel.render(80).length, initialHeight);
  panel.handleInput?.("x");
  panel.handleInput?.("y");
  assert.deepEqual(stopped, [running.id]);
  panel.handleInput?.("\x1b");
  assert.ok(closed);
  const rendersAtClose = renders;
  jobs = [];
  await wait(300);
  assert.equal(renders, rendersAtClose);
}

async function checkScrollbackAndPath(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-scroll-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const jobs: PanelTask[] = [
    {
      id: "other",
      name: "Other job",
      outputPath: join(cwd, "other.log"),
      status: "running",
    },
    {
      id: "chosen",
      name: "Chosen job",
      outputPath: join(cwd, "chosen.log"),
      status: "running",
    },
  ];
  const path = jobs[1].outputPath;
  await writeFile(path, Array.from({ length: 36 }, (_, i) => `entry ${String(i + 1).padStart(2, "0")}\n`).join(""));
  const panel = createTaskPanel(
    {
      terminal: { rows: 24 } as Parameters<typeof createTaskPanel>[0]["terminal"],
      requestRender() {
        // This test renders explicitly when inspecting the panel.
      },
    },
    { matches: () => false },
    () => assert.fail("Panel closed"),
    () => jobs,
    () => Promise.reject(new Error("Unexpected stop")),
    "chosen",
  );
  t.after(() => panel.dispose());
  const display = (width = 80) => panel.render(width).join("\n");
  const press = (key: string) => panel.handleInput?.(key);
  await until(() => display().includes("entry 36"));
  assert.match(display(), /› [⠋⠙⠹⠸] Chosen job/);
  assert.match(display(), /LIVE/);

  press("\x1b[5~"); // Page Up
  const earlier = display().match(/entry \d+/g);
  assert.ok(earlier?.length);
  assert.match(display(), /⏸ PAUSED/);
  assert.doesNotMatch(display(), /entry 36/);
  press("\x1b[6~"); // Page Down
  assert.match(display(), /entry 36/);
  press("\x1b[5~");
  await appendFile(path, "latest output\n");
  await wait(300);
  assert.deepEqual(display().match(/entry \d+/g), earlier);
  assert.doesNotMatch(display(), /latest output/);

  press("p");
  assert.match(display(), /Log path/);
  assert.ok(display(180).includes(path));
  const wrapped = panel
    .render(20)
    .slice(1, -3)
    .map((line) => line.slice(1, -1).trim())
    .join("");
  assert.equal(wrapped, path);
  press("\x1b");
  assert.match(display(), /PAUSED/);
  press("\x1b[F"); // End
  await until(() => display().includes("latest output"));
  assert.match(display(), /LIVE/);
}

async function checkThemeTallPreviewAndOverflow(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-theme-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const logPath = join(cwd, "tall.log");
  await writeFile(logPath, Array.from({ length: 30 }, (_, i) => `row ${String(i + 1).padStart(2, "0")}\n`).join(""));
  const jobs: PanelTask[] = Array.from({ length: 7 }, (_, i) => ({
    id: `job-${i + 1}`,
    name: `Task ${i + 1}`,
    outputPath: logPath,
    status: i === 0 ? "running" : "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: i === 0 ? undefined : "2026-01-01T00:00:12.000Z",
  }));
  const mockTheme: PanelTheme = {
    fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
    bg: (_color, text) => `\x1b[44m${text}\x1b[49m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
  const panel = createTaskPanel(
    {
      terminal: { rows: 40 } as Parameters<typeof createTaskPanel>[0]["terminal"],
      requestRender() {
        // Explicit rendering below.
      },
    },
    { matches: () => false },
    () => assert.fail("Panel closed"),
    () => jobs,
    () => Promise.reject(new Error("Unexpected stop")),
    undefined,
    mockTheme,
  );
  t.after(() => panel.dispose());
  const render = (width = 90) => panel.render(width);
  await until(() => stripTerminalSequences(render().join("\n")).includes("row 30"));

  const lines = render(90);
  assert.ok(lines.every((line) => visibleWidth(line) === 90));
  assert.ok(lines.some((line) => line.includes("\x1b[44m")));
  const plain = stripTerminalSequences(lines.join("\n"));
  assert.match(plain, /Background Tasks · 1 running · 1\/7/);
  const visibleRows = plain.match(/row \d+/g) ?? [];
  assert.ok(visibleRows.length > 12, `Expected >12 preview rows on tall terminal, got ${visibleRows.length}`);
}

function mouseEvent(overrides: Partial<TuiMouseEvent> & Pick<TuiMouseEvent, "type">): TuiMouseEvent {
  return {
    button: "none",
    x: 4,
    y: 0,
    screenX: 4,
    screenY: 0,
    width: 80,
    height: 19,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

async function checkMouseWheelAndClick(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-mouse-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const firstLog = join(cwd, "first.log");
  const secondLog = join(cwd, "second.log");
  await writeFile(firstLog, Array.from({ length: 30 }, (_, i) => `first ${String(i + 1).padStart(2, "0")}\n`).join(""));
  await writeFile(secondLog, "second job output\n");
  const jobs: PanelTask[] = [
    { id: "first", name: "First job", outputPath: firstLog, status: "running" },
    { id: "second", name: "Second job", outputPath: secondLog, status: "completed", exitCode: 0 },
  ];
  const panel = createTaskPanel(
    {
      terminal: { rows: 24 } as Parameters<typeof createTaskPanel>[0]["terminal"],
      requestRender() {
        // Explicit rendering below.
      },
    },
    { matches: () => false },
    () => assert.fail("Panel closed"),
    () => jobs,
    () => Promise.reject(new Error("Unexpected stop")),
  );
  t.after(() => panel.dispose());
  const display = () => panel.render(80).join("\n");
  await until(() => display().includes("first 30"));
  assert.match(display(), /LIVE/);

  // Wheel up pauses LIVE and scrolls back.
  const upResult = panel.handleMouse?.(mouseEvent({ type: "wheel", wheelDelta: -6 }));
  assert.equal(upResult?.handled, true);
  assert.match(display(), /⏸ PAUSED/);
  assert.doesNotMatch(display(), /first 30/);

  // Wheel down past the bottom automatically resumes LIVE and loads new output.
  await appendFile(firstLog, "first 31\n");
  const downResult = panel.handleMouse?.(mouseEvent({ type: "wheel", wheelDelta: 10 }));
  assert.equal(downResult?.handled, true);
  await until(() => display().includes("first 31"));
  assert.match(display(), /LIVE/);

  // Pressing on the log output area returns undefined so Pi's text selection can drag-select logs.
  const outputPress = panel.handleMouse?.(mouseEvent({ type: "press", button: "left", y: 6 }));
  assert.equal(outputPress, undefined);

  // Left-clicking the second job row (y = 2: row 0 is top border, row 1 is first job, row 2 is second job).
  const clickResult = panel.handleMouse?.(mouseEvent({ type: "press", button: "left", y: 2 }));
  assert.equal(clickResult?.handled, true);
  await until(() => display().includes("second job output"));
  assert.match(display(), /› ✓ Second job/);
}

async function checkQueuedTaskDisplayAndStop(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-queued-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runningLog = join(cwd, "running.log");
  const queuedLog = join(cwd, "queued.log");
  await writeFile(runningLog, "upstream running\n");
  let jobs: PanelTask[] = [
    { id: "up01", name: "Upstream job", outputPath: runningLog, status: "running" },
    {
      id: "down02",
      name: "Downstream job",
      outputPath: queuedLog,
      status: "queued",
      queuedAt: "2026-01-01T00:00:00.000Z",
      after: ["up01"],
    },
  ];
  const stopped: string[] = [];
  const panel = createTaskPanel(
    {
      terminal: { rows: 24 } as Parameters<typeof createTaskPanel>[0]["terminal"],
      requestRender() {
        // Explicit rendering below.
      },
    },
    { matches: () => false },
    () => assert.fail("Panel closed"),
    () => jobs,
    async (id) => {
      stopped.push(id);
      await Promise.resolve();
    },
    "down02",
  );
  t.after(() => panel.dispose());
  const display = () => panel.render(80).join("\n");
  await until(() => display().includes("QUEUED"));
  assert.match(display(), /Background Tasks · 1 running, 1 queued/);
  assert.match(display(), /› ◷ Downstream job.*after Upstream job \(up01\)/);
  assert.match(display(), /◷ QUEUED/);
  assert.match(display(), /\(waiting for Upstream job \(up01\) to finish\)/);
  assert.match(display(), /x stop/);

  // Falls back to afterNames when an upstream task is not in the visible job list.
  jobs = [
    {
      ...jobs[1],
      after: ["up01", "old00"],
      afterNames: { up01: "Upstream job", old00: "Evicted job" },
    },
  ];
  await until(() => display().includes("Evicted job (old00)"));
  assert.match(display(), /› ◷ Downstream job.*after 2 tasks/);
  assert.match(display(), /\(waiting for Upstream job \(up01\), Evicted job \(old00\) to finish\)/);
  jobs = [
    { id: "up01", name: "Upstream job", outputPath: runningLog, status: "running" },
    {
      id: "down02",
      name: "Downstream job",
      outputPath: queuedLog,
      status: "queued",
      queuedAt: "2026-01-01T00:00:00.000Z",
      after: ["up01"],
    },
  ];
  await until(() => display().includes("1 running, 1 queued"));

  // Can stop a queued task.
  panel.handleInput?.("x");
  panel.handleInput?.("y");
  assert.deepEqual(stopped, ["down02"]);

  // Transitions cleanly to LIVE output once queued task starts running.
  await writeFile(queuedLog, "downstream started\n");
  jobs = [
    jobs[0],
    {
      ...jobs[1],
      status: "running",
      startedAt: new Date().toISOString(),
    },
  ];
  await until(() => display().includes("downstream started"));
  assert.match(display(), /LIVE/);
}

test("task panel marks clipped output and confirms stopping only the selected live job", posix, checkClippingAndStop);
test("opens a job by ID, freezes scrollback, and shows its full log path", posix, checkScrollbackAndPath);
test(
  "applies theme styling, fills tall preview height, and shows job overflow count",
  posix,
  checkThemeTallPreviewAndOverflow,
);
test("supports mouse wheel scrolling and clicking to select jobs", posix, checkMouseWheelAndClick);
test(
  "shows queued DAG tasks, allows stopping them, and switches to LIVE when started",
  posix,
  checkQueuedTaskDisplayAndStop,
);
