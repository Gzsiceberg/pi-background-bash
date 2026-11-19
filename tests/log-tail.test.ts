import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLogTail } from "../src/log-tail.ts";

test(
  "reports byte and line clipping separately from a complete preview",
  { skip: process.platform === "win32" },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-bg-tail-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const log = join(cwd, "output.log");
    await writeFile(log, "first\n🙂last\n");

    assert.deepEqual(await readLogTail(log, 64, 2), {
      lines: ["first", "🙂last"],
      clipped: false,
    });
    assert.deepEqual(await readLogTail(log, 64, 1), {
      lines: ["🙂last"],
      clipped: true,
    });
    assert.deepEqual(await readLogTail(log, 7, 2), {
      lines: ["last"],
      clipped: true,
    });
  },
);
