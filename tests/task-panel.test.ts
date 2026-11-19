import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";

import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

import { createTaskPanel, type PanelTask } from "../src/task-panel.ts";

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) {
      return;
    }
    await wait(20);
  }
  assert.fail("Timed out waiting for the task panel to refresh");
}

test(
  "task panel marks clipped output and confirms stopping only the selected live job",
  {
    skip: process.platform === "win32",
    timeout: 10_000,
  },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-bg-panel-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const running: PanelTask = {
      id: "run",
      name: "Live build",
      outputPath: join(cwd, "live.log"),
      status: "running",
    };
    const finished: PanelTask = {
      id: "done",
      name: "Old test",
      outputPath: join(cwd, "old.log"),
      status: "completed",
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
    assert.match(display(), /No background tasks/);
    assert.match(display(), /Ask Pi to run your tests in the background/);
    jobs = [running, finished];
    await until(() => display().includes("first line"));
    assert.match(display(), /› \[running\] Live build/);
    assert.match(display(), /\[completed\] Old test/);
    assert.ok(!display().includes("\x1b"));
    assert.doesNotMatch(display(), /live\.log/);

    await appendFile(running.outputPath, "\x1b[31mnew output\x1b[0m\n");
    await until(() => display().includes("new output"));
    assert.ok(
      !display()
        .split("\n")
        .find((line) => line.includes("new output"))!
        .includes("\x1b"),
    );
    assert.ok(panel.render(12).every((line) => visibleWidth(line) <= 12));

    assert.doesNotMatch(display(), /Output clipped/);
    terminal.rows = 4;
    assert.match(display(), /… new output/);
    assert.match(display(), /Esc close/);
    terminal.rows = 24;
    await appendFile(running.outputPath, `${"line\n".repeat(13)}last line\n`);
    await until(() => display().includes("last line"));
    assert.match(display(), /LIVE · Output clipped/);
    assert.doesNotMatch(display(), /first line/);

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
    assert.match(display(), /› \[stopping\].*Live build/);
    panel.handleInput?.("x");
    panel.handleInput?.("y");
    assert.deepEqual(stopped, [running.id]);

    jobs = [
      finished,
      {
        ...running,
        status: "killed",
        error: "Stopped from /bg-tasks",
      },
    ];
    assert.ok(finishStop);
    finishStop();
    await until(() => /› \[killed\].*Live build/.test(display()));
    assert.doesNotMatch(display(), /Stopped from \/bg-tasks/);
    assert.match(display(), /last line/);

    panel.handleInput?.("\x1b[A");
    await until(() => display().includes("previous output"));
    assert.match(display(), /› \[completed\] Old test/);
    panel.handleInput?.("x");
    panel.handleInput?.("y");
    assert.deepEqual(stopped, [running.id]);
    panel.handleInput?.("\x1b");
    assert.ok(closed);
    const rendersAtClose = renders;
    jobs = [];
    await wait(300);
    assert.equal(renders, rendersAtClose);
  },
);

test(
  "opens a job by ID, freezes scrollback, and shows its full log path",
  {
    skip: process.platform === "win32",
    timeout: 10_000,
  },
  async (t) => {
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
    assert.match(display(), /› \[running\].*Chosen job/);
    assert.match(display(), /LIVE/);

    press("\x1b[5~"); // Page Up
    const earlier = display().match(/entry \d+/g);
    assert.ok(earlier?.length);
    assert.match(display(), /PAUSED/);
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
      .slice(2, -2)
      .map((line) => line.slice(1, -1).trimEnd())
      .join("");
    assert.equal(wrapped, path);
    press("\x1b");
    assert.match(display(), /PAUSED/);
    press("\x1b[F"); // End
    await until(() => display().includes("latest output"));
    assert.match(display(), /LIVE/);
  },
);
