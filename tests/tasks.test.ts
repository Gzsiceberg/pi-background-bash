import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createTasks, MAX_OUTPUT_BYTES } from "../src/tasks.ts";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-bash-"));
  const tasks = createTasks();
  t.after(async () => {
    await tasks.shutdown("Test ended");
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, root: join(cwd, ".pi", "tasks"), tasks };
}

const posix = { skip: process.platform === "win32", timeout: 5000 };

test("returns before the command ends and captures Bash stdout and stderr in the project", posix, async (t) => {
  const { cwd, root, tasks } = await fixture(t);
  const { task, done } = await tasks.run(cwd, root, {
    name: "Bash syntax test",
    command:
      'while [[ ! -f proceed ]]; do sleep 0.02; done; words=(test passed); printf "%s\\n" "${words[*]}"; echo stderr >&2',
    timeoutSeconds: 4,
  });
  assert.equal(task.status, "running");
  assert.match(task.id, /^[0-9a-f]{8}$/);
  assert.equal(task.outputPath, join(root, task.id, "output.log"));
  assert.equal(task.resultPath, join(root, task.id, "result.json"));
  assert.ok(task.pid);
  assert.equal(task.triggerOnCompletion, true);
  await assert.rejects(access(task.resultPath), { code: "ENOENT" });
  await writeFile(join(cwd, "proceed"), "");
  const result = await done;
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  const output = await readFile(task.outputPath, "utf8");
  assert.match(output, /test passed\n/);
  assert.match(output, /stderr\n/);
  assert.equal(JSON.parse(await readFile(task.resultPath, "utf8")).status, "completed");
  assert.equal((await stat(task.outputPath)).mode & 0o777, 0o600);
});

test("records nonzero exits and keeps parallel jobs separate", posix, async (t) => {
  const { cwd, root, tasks } = await fixture(t);
  const [a, b] = await Promise.all([
    tasks.run(cwd, root, {
      name: "Expected failure",
      command: "echo failure; exit 42",
      notifyOnCompletion: false,
    }),
    tasks.run(cwd, root, {
      name: "Expected success",
      command: "echo success",
      triggerOnCompletion: false,
    }),
  ]);
  assert.notEqual(a.task.id, b.task.id);
  assert.equal(a.task.triggerOnCompletion, false);
  assert.equal(b.task.notifyOnCompletion, true);
  assert.equal(b.task.triggerOnCompletion, false);
  const [failed, succeeded] = await Promise.all([a.done, b.done]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 42);
  assert.equal(succeeded.status, "completed");
  assert.equal(await readFile(failed.outputPath, "utf8"), "failure\n");
  assert.equal(await readFile(succeeded.outputPath, "utf8"), "success\n");
});

test("times out a Bash process group, including descendants holding the output open", posix, async (t) => {
  const { cwd, root, tasks } = await fixture(t);
  const { done } = await tasks.run(cwd, root, {
    name: "Expiring test",
    command: "sleep 60 & wait",
    timeoutSeconds: 0.15,
  });
  const result = await done;
  assert.equal(result.status, "failed");
  assert.equal(result.signal, "SIGKILL");
  assert.match(result.error ?? "", /Timed out/);
});

test("stops only the selected live job and records why it was stopped", posix, async (t) => {
  const { cwd, root, tasks } = await fixture(t);
  const selected = await tasks.run(cwd, root, {
    name: "Selected test",
    command: "sleep 60 & wait",
  });
  const other = await tasks.run(cwd, root, {
    name: "Other test",
    command: "while [[ ! -f proceed ]]; do sleep 0.02; done; echo done",
    timeoutSeconds: 4,
  });
  assert.equal(await tasks.stop("unknown", "Not found"), undefined);
  const reason = "Stopped from /bg-tasks";
  const result = await tasks.stop(selected.task.id, reason);
  assert.ok(result);
  assert.equal(result, await selected.done);
  assert.equal(result.status, "killed");
  assert.equal(result.signal, "SIGKILL");
  assert.equal(JSON.parse(await readFile(result.resultPath, "utf8")).error, reason);
  assert.equal(await tasks.stop(selected.task.id, reason), undefined);
  await writeFile(join(cwd, "proceed"), "");
  assert.equal((await other.done).status, "completed");
});

test("stops and records live jobs on session shutdown", posix, async (t) => {
  const { cwd, root, tasks } = await fixture(t);
  const job = await tasks.run(cwd, root, {
    name: "Active test",
    command: "sleep 60 & wait",
  });
  await tasks.shutdown("Pi session ended (reload)");
  const result = await job.done;
  assert.equal(result.status, "killed");
  assert.equal(result.signal, "SIGKILL");
  assert.equal(JSON.parse(await readFile(result.resultPath, "utf8")).status, "killed");
  await assert.rejects(tasks.run(cwd, root, { name: "Late test", command: "true" }), /shutting down/);
});

test("caps on-disk logs and fails the task instead of silently truncating", posix, async (t) => {
  const { cwd, root, tasks } = await fixture(t);
  const { done } = await tasks.run(cwd, root, {
    name: "Large output test",
    command: "yes",
    timeoutSeconds: 4,
  });
  const result = await done;
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /20 MiB limit/);
  assert.equal((await stat(result.outputPath)).size, MAX_OUTPUT_BYTES);
});

test("rejects empty commands, invalid timeouts, aborted launches, and spawn failures", posix, async (t) => {
  const { cwd, root, tasks } = await fixture(t);
  await assert.rejects(tasks.run(cwd, root, { name: "Empty test", command: " " }), /empty/);
  await assert.rejects(
    tasks.run(cwd, root, {
      name: "Invalid test",
      command: "true",
      timeoutSeconds: Infinity,
    }),
    /timeoutSeconds/,
  );
  await assert.rejects(tasks.run(cwd, root, { name: "Aborted test", command: "true" }, AbortSignal.abort()), {
    name: "AbortError",
  });
  await assert.rejects(access(root), { code: "ENOENT" });
  await assert.rejects(
    tasks.run(join(cwd, "missing"), root, {
      name: "Missing cwd",
      command: "true",
    }),
    /Could not start Bash/,
  );
  assert.deepEqual(await readdir(root), []);
});

test(
  "schedules a task after a previous task ID and still starts when upstream fails or is stopped",
  posix,
  async (t) => {
    const { cwd, root, tasks } = await fixture(t);
    const first = await tasks.run(cwd, root, {
      name: "Failing first step",
      command: "while [[ ! -f release ]]; do sleep 0.02; done; echo first >> trace.log; exit 7",
      timeoutSeconds: 4,
    });
    const second = await tasks.run(cwd, root, {
      name: "Second step after failure",
      command: "echo second >> trace.log",
      after: [first.task.id],
      timeoutSeconds: 4,
    });
    assert.equal(second.task.status, "queued");
    assert.equal(second.task.pid, undefined);
    assert.deepEqual(second.task.after, [first.task.id]);
    await assert.rejects(access(second.task.outputPath), { code: "ENOENT" });

    await writeFile(join(cwd, "release"), "");
    const [firstResult, secondResult] = await Promise.all([first.done, second.done]);
    assert.equal(firstResult.status, "failed");
    assert.equal(firstResult.exitCode, 7);
    assert.equal(secondResult.status, "completed");
    assert.equal(secondResult.exitCode, 0);
    assert.equal(await readFile(join(cwd, "trace.log"), "utf8"), "first\nsecond\n");

    // Scheduling after an already-finished task starts immediately.
    const third = await tasks.run(cwd, root, {
      name: "Immediate after finished",
      command: "echo third >> trace.log",
      after: [second.task.id],
    });
    assert.equal(third.task.status, "running");
    assert.deepEqual(third.task.after, [second.task.id]);
    assert.equal((await third.done).status, "completed");
    assert.equal(await readFile(join(cwd, "trace.log"), "utf8"), "first\nsecond\nthird\n");
  },
);

test("stopping a queued task cancels it without spawning while downstream still starts", posix, async (t) => {
  const { cwd, root, tasks } = await fixture(t);
  const blocker = await tasks.run(cwd, root, {
    name: "Blocker",
    command: "while [[ ! -f go ]]; do sleep 0.02; done",
    timeoutSeconds: 4,
  });
  const middle = await tasks.run(cwd, root, {
    name: "Cancelled middle",
    command: "touch middle-ran",
    after: [blocker.task.id],
  });
  const finalStep = await tasks.run(cwd, root, {
    name: "Final step",
    command: "echo final-ran",
    after: [middle.task.id],
  });
  assert.equal(middle.task.status, "queued");
  assert.equal(finalStep.task.status, "queued");

  const stopped = await tasks.stop(middle.task.id, "Cancelled by user");
  assert.ok(stopped);
  assert.equal(stopped, await middle.done);
  assert.equal(stopped.status, "killed");
  assert.equal(stopped.startedAt, undefined);
  assert.equal(await middle.started, undefined);
  assert.equal(JSON.parse(await readFile(stopped.resultPath, "utf8")).error, "Cancelled by user");
  await assert.rejects(access(join(cwd, "middle-ran")), { code: "ENOENT" });

  // Because middle settled (killed), finalStep starts even while blocker is still running.
  const finalResult = await finalStep.done;
  assert.equal(finalResult.status, "completed");
  assert.equal(await readFile(finalResult.outputPath, "utf8"), "final-ran\n");

  await writeFile(join(cwd, "go"), "");
  assert.equal((await blocker.done).status, "completed");
});

test("shutdown cancels queued tasks without spawning them", posix, async (t) => {
  const { cwd, root, tasks } = await fixture(t);
  const blocker = await tasks.run(cwd, root, {
    name: "Blocker",
    command: "sleep 60 & wait",
  });
  const queued = await tasks.run(cwd, root, {
    name: "Should not run",
    command: "touch ran-after-shutdown",
    after: [blocker.task.id],
  });
  await tasks.shutdown("Pi session ended (exit)");
  const [blockerResult, queuedResult] = await Promise.all([blocker.done, queued.done]);
  assert.equal(blockerResult.status, "killed");
  assert.equal(queuedResult.status, "killed");
  assert.equal(queuedResult.startedAt, undefined);
  assert.equal(queuedResult.error, "Pi session ended (exit)");
  await assert.rejects(access(join(cwd, "ran-after-shutdown")), { code: "ENOENT" });
});

test(
  "starts timeout clock only once a queued task begins running and records late spawn failures",
  posix,
  async (t) => {
    const { cwd, root, tasks } = await fixture(t);
    const slow = await tasks.run(cwd, root, {
      name: "Slow predecessor",
      command: "sleep 0.25",
      timeoutSeconds: 4,
    });
    const shortTimeout = await tasks.run(cwd, root, {
      name: "Short timeout successor",
      command: "echo ok",
      after: [slow.task.id],
      timeoutSeconds: 0.2,
    });
    const brokenCwd = await tasks.run(join(cwd, "does-not-exist"), root, {
      name: "Bad cwd successor",
      command: "echo never",
      after: [slow.task.id],
    });
    const [slowResult, shortResult, brokenResult] = await Promise.all([slow.done, shortTimeout.done, brokenCwd.done]);
    assert.equal(slowResult.status, "completed");
    assert.equal(shortResult.status, "completed");
    assert.equal(brokenResult.status, "failed");
    assert.match(brokenResult.error ?? "", /Could not start Bash/);
    assert.equal(await brokenCwd.started, undefined);
  },
);

async function checkDiamondDag(t: TestContext) {
  const { cwd, root, tasks } = await fixture(t);
  const external = await tasks.run(cwd, root, {
    name: "External seed",
    command: "echo external >> events.log",
  });
  await external.done;

  const handles = await tasks.runDag(cwd, root, [
    {
      key: "join",
      name: "Join step",
      command: "echo join >> events.log",
      after: ["left", "right"],
    },
    {
      key: "left",
      name: "Left branch (fails)",
      command: "echo left >> events.log; exit 1",
      after: ["root"],
    },
    {
      key: "right",
      name: "Right branch",
      command: "sleep 0.05; echo right >> events.log",
      after: ["root"],
    },
    {
      key: "root",
      name: "Root step",
      command: "echo root >> events.log; exit 2",
      after: [external.task.id],
    },
  ]);

  // Preserves caller order.
  assert.deepEqual(
    handles.map((item) => item.key),
    ["join", "left", "right", "root"],
  );
  assert.equal(handles[3].task.status, "running");
  assert.equal(handles[0].task.status, "queued");
  assert.equal(handles[1].task.status, "queued");
  assert.equal(handles[2].task.status, "queued");
  assert.deepEqual(handles[0].task.after, [handles[1].task.id, handles[2].task.id]);

  const results = await Promise.all(handles.map((item) => item.done));
  assert.equal(results[3].status, "failed");
  assert.equal(results[1].status, "failed");
  assert.equal(results[2].status, "completed");
  assert.equal(results[0].status, "completed");

  const lines = (await readFile(join(cwd, "events.log"), "utf8")).trim().split("\n");
  assert.equal(lines[0], "external");
  assert.equal(lines[1], "root");
  assert.deepEqual(new Set(lines.slice(2, 4)), new Set(["left", "right"]));
  assert.equal(lines[4], "join");
}

test(
  "runDag executes a diamond DAG in topological order even with forward references and upstream failure",
  posix,
  checkDiamondDag,
);

test(
  "rejects unknown dependencies, duplicate keys, empty DAGs, and cycles before starting any tasks",
  posix,
  async (t) => {
    const { cwd, root, tasks } = await fixture(t);
    await assert.rejects(
      tasks.run(cwd, root, { name: "Missing dep", command: "true", after: ["deadbeef"] }),
      /Unknown dependency/,
    );
    await assert.rejects(tasks.run(cwd, root, { name: "Blank dep", command: "true", after: [" "] }), /empty/);
    await assert.rejects(tasks.runDag(cwd, root, []), /at least one task/);
    await assert.rejects(
      tasks.runDag(cwd, root, [
        { key: "dup", name: "First", command: "true" },
        { key: "dup", name: "Second", command: "true" },
      ]),
      /Duplicate DAG task key/,
    );
    await assert.rejects(
      tasks.runDag(cwd, root, [{ key: "self", name: "Self loop", command: "true", after: ["self"] }]),
      /Dependency cycle/,
    );
    await assert.rejects(
      tasks.runDag(cwd, root, [
        { key: "ok", name: "Independent", command: "touch should-not-run" },
        { key: "a", name: "A", command: "true", after: ["b"] },
        { key: "b", name: "B", command: "true", after: ["a"] },
      ]),
      /Dependency cycle/,
    );
    await assert.rejects(
      tasks.runDag(cwd, root, [{ key: "a", name: "A", command: "true", after: ["missing"] }]),
      /Unknown dependency/,
    );
    await assert.rejects(access(root), { code: "ENOENT" });
    await assert.rejects(access(join(cwd, "should-not-run")), { code: "ENOENT" });
  },
);
