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
