import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const projectFile = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

const posix = { skip: process.platform === "win32", timeout: 15_000 };

async function openPi(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-rpc-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = spawn(
    process.execPath,
    [
      projectFile("../node_modules/.bin/pi"),
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-extensions",
      "--no-builtin-tools",
      "--no-approve",
      "--provider",
      "bg-fixture",
      "--model",
      "scripted",
      "-e",
      projectFile("../"),
      "-e",
      projectFile("./scripted-provider.mjs"),
    ],
    { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "agent") } },
  );
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const abort = () => child.kill("SIGTERM");
  t.signal.addEventListener("abort", abort, { once: true });
  return {
    cwd,
    lines,
    send(command: object) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    async close() {
      child.stdin.end();
      await closed;
      t.signal.removeEventListener("abort", abort);
      assert.equal(child.exitCode, 0, stderr);
    },
  };
}

test(
  "Pi loads bg_run and wakes the model after a background job finishes",
  posix,
  async (t) => {
    const { cwd, lines, send, close } = await openPi(t);
    send({ id: "prompt", type: "prompt", message: "Run the fixture job" });
    let notified = false;
    let outputPath: string | undefined;
    try {
      for await (const line of lines) {
        const event = JSON.parse(line);
        const text = JSON.stringify(event);
        if (event.type === "response" && event.id === "prompt") {
          assert.equal(event.success, true, text);
        }
        if (
          event.type === "agent_end" &&
          text.includes("Fixture initial reply")
        ) {
          assert.equal(notified, false);
          await writeFile(join(cwd, "proceed"), "");
        }
        if (
          event.type === "message_end" &&
          event.message.customType === "background-task-notification"
        ) {
          assert.equal(notified, false);
          assert.equal(event.message.details.task.status, "completed");
          assert.match(
            event.message.content.split("\n")[1],
            /^".+" completed · \d+s$/,
          );
          assert.doesNotMatch(
            event.message.content,
            /fixture (live marker|output)/,
          );
          outputPath = event.message.details.task.outputPath;
          notified = true;
        }
        if (event.type === "agent_end" && text.includes("Fixture follow-up")) {
          break;
        }
      }
    } finally {
      await close();
    }
    assert.ok(notified && outputPath);
    assert.equal(
      await readFile(outputPath, "utf8"),
      "fixture live marker\nfixture output\n",
    );
  },
);

test("Pi registers /bg-tasks but not /bg", posix, async (t) => {
  const { lines, send, close } = await openPi(t);
  send({ id: "commands", type: "get_commands" });
  let checked = false;
  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.type !== "response" || event.id !== "commands") {
        continue;
      }
      assert.equal(event.success, true, line);
      const names = event.data.commands.map(
        (command: { name: string }) => command.name,
      );
      assert.ok(names.includes("bg-tasks"));
      assert.ok(!names.includes("bg"));
      checked = true;
      break;
    }
  } finally {
    await close();
  }
  assert.ok(checked);
});
