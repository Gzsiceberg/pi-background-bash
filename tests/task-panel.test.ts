import { matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createTaskPanel, type PanelTask } from '../src/task-panel.ts';

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await wait(20);
  }
  assert.fail('Timed out waiting for the task panel to refresh');
}

test('task panel follows output, keeps selection when the task finishes, and switches jobs', {
  skip: process.platform === 'win32', timeout: 10_000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-bg-panel-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const running: PanelTask = { id: 'run', name: 'Live build', outputPath: join(cwd, 'live.log'), status: 'running' };
  const finished: PanelTask = { id: 'done', name: 'Old test', outputPath: join(cwd, 'old.log'), status: 'completed', exitCode: 0 };
  await writeFile(running.outputPath, 'first line\n');
  await writeFile(finished.outputPath, 'previous output\n');
  let jobs: PanelTask[] = [];
  let renders = 0;
  let closed = false;
  const terminal = { rows: 24 } as Parameters<typeof createTaskPanel>[0]['terminal'];
  const keys = { matches(data: string, binding: string) {
    if (binding === 'tui.select.up') return matchesKey(data, 'up');
    if (binding === 'tui.select.down') return matchesKey(data, 'down');
    return false;
  } };
  const panel = createTaskPanel(
    { terminal, requestRender: () => { renders++; } },
    { fg: (_color, text) => text }, keys, () => { closed = true; panel.dispose?.(); }, () => jobs,
  );
  t.after(() => panel.dispose?.());
  const display = () => panel.render(80).join('\n');
  assert.match(display(), /No background tasks/);
  jobs = [running, finished];
  await until(() => display().includes('first line'));
  assert.match(display(), /\[running\] Live build/);

  await appendFile(running.outputPath, '\x1b[31mnew output\x1b[0m\n');
  await until(() => display().includes('new output'));
  assert.doesNotMatch(display(), /\x1b/);
  assert.ok(panel.render(12).every((line) => visibleWidth(line) <= 12));

  jobs = [finished, { ...running, status: 'failed', exitCode: 1, error: 'Build failed' }];
  await until(() => display().includes('[failed] Live build · exit 1'));
  assert.match(display(), /Build failed/);
  assert.match(display(), /new output/);
  assert.match(display(), /Background tasks · 2\/2/);

  panel.handleInput?.('\x1b[A');
  await until(() => display().includes('previous output'));
  assert.match(display(), /\[completed\] Old test/);
  panel.handleInput?.('\x1b');
  assert.ok(closed);
  const rendersAtClose = renders;
  jobs = [];
  await wait(300);
  assert.equal(renders, rendersAtClose);
});
