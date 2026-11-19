import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectFile = (path: string) => fileURLToPath(new URL(path, import.meta.url));

test('Pi loads bg_run and wakes the model after a background job finishes', {
  skip: process.platform === 'win32', timeout: 15_000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-bg-rpc-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = spawn(process.execPath, [
    projectFile('../node_modules/.bin/pi'), '--mode', 'rpc', '--no-session', '--offline',
    '--no-extensions', '--no-builtin-tools', '--no-approve',
    '--provider', 'bg-fixture', '--model', 'scripted',
    '-e', projectFile('../'), '-e', projectFile('./scripted-provider.mjs'),
  ], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, 'agent') } });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ id: 'prompt', type: 'prompt', message: 'Run the fixture job' })}\n`);
  let notified = false;
  let outputPath: string | undefined;
  const lines = createInterface({ input: child.stdout });
  const abort = () => child.kill('SIGTERM');
  t.signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      const text = JSON.stringify(event);
      if (event.type === 'response' && event.id === 'prompt') assert.equal(event.success, true, text);
      if (event.type === 'agent_end' && text.includes('Fixture initial reply')) {
        assert.equal(notified, false);
        await writeFile(join(cwd, 'proceed'), '');
      }
      if (event.type === 'message_end' && event.message.customType === 'background-task-notification') {
        assert.equal(notified, false);
        assert.equal(event.message.details.task.status, 'completed');
        assert.doesNotMatch(event.message.content, /fixture output/);
        outputPath = event.message.details.task.outputPath;
        notified = true;
      }
      if (event.type === 'agent_end' && text.includes('Fixture follow-up')) break;
    }
  } finally {
    child.stdin.end();
    await closed;
    t.signal.removeEventListener('abort', abort);
  }
  assert.equal(child.exitCode, 0, stderr);
  assert.ok(notified && outputPath, stderr);
  assert.equal(await readFile(outputPath, 'utf8'), 'fixture output\n');
});
