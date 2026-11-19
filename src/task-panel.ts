import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import { LOG_REFRESH_MS, plainText, readLogTail } from './log-tail.ts';

const TAIL_BYTES = 32 * 1024;
const TAIL_LINES = 12;

export interface PanelTask {
  id: string;
  name: string;
  outputPath: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  error?: string;
  exitCode?: number | null;
}

export function createTaskPanel(
  tui: Pick<TUI, 'terminal' | 'requestRender'>,
  theme: Pick<Theme, 'fg'>,
  keys: Pick<KeybindingsManager, 'matches'>,
  close: () => void,
  getTasks: () => PanelTask[],
): Component & { dispose(): void } {
  let tasks: PanelTask[] = [];
  let selectedId: string | undefined;
  const current = () => tasks.find((task) => task.id === selectedId);
  let lines: string[] = [];
  let loaded: PanelTask | undefined;
  let reading = false;
  let disposed = false;

  async function refresh() {
    const next = getTasks();
    if (next.length !== tasks.length || next.some((task, i) => task !== tasks[i])) {
      tasks = next;
      if (!current()) selectedId = tasks[0]?.id;
      tui.requestRender();
    }
    const task = current();
    if (disposed || reading || !task || (task === loaded && task.status !== 'running')) return;
    reading = true;
    try {
      const tail = await readLogTail(task.outputPath, TAIL_BYTES, TAIL_LINES).catch(() => ['(output log unavailable)']);
      if (!disposed && task === current()) {
        const changed = task !== loaded || lines.length !== tail.length || lines.some((line, i) => line !== tail[i]);
        loaded = task;
        lines = tail;
        if (changed) tui.requestRender();
      }
    } finally {
      reading = false;
    }
  }

  const timer = setInterval(() => void refresh(), LOG_REFRESH_MS);
  timer.unref();
  void refresh();

  return {
    render(width) {
      if (width <= 0) return [];
      const task = current();
      const position = task ? `${tasks.indexOf(task) + 1}/${tasks.length}` : '';
      const title = theme.fg('accent', `Background tasks${position ? ` · ${position}` : ''}`);
      const hint = theme.fg('dim', task ? '↑/↓ switch task · Esc close' : 'Esc close');
      const body = [title];
      const height = Math.floor(tui.terminal.rows * 0.8);
      if (task) {
        const exit = task.exitCode == null ? '' : ` · exit ${task.exitCode}`;
        body.push(`[${task.status}] ${plainText(task.name)}${exit}`);
        if (task.error) body.push(theme.fg('warning', plainText(task.error)));
        const visibleLines = loaded?.id === task.id && lines.length
          ? lines : [task.status === 'running' ? '(waiting for output)' : '(no output)'];
        body.push(...visibleLines.slice(-Math.max(1, height - body.length - 3)));
      } else {
        body.push('No background tasks in this Pi session.');
      }
      body.push(hint);
      if (width < 3 || height < 5) {
        return body.slice(0, Math.max(1, height)).map((line) => truncateToWidth(line, width));
      }
      const border = '─'.repeat(width - 2);
      const side = theme.fg('border', '│');
      return [
        theme.fg('border', `╭${border}╮`),
        ...body.slice(0, height - 2).map((line) => `${side}${truncateToWidth(line, width - 2, '…', true)}${side}`),
        theme.fg('border', `╰${border}╯`),
      ];
    },
    handleInput(data) {
      if (matchesKey(data, 'escape') || keys.matches(data, 'tui.select.cancel')) {
        close();
        return;
      }
      const offset = keys.matches(data, 'tui.select.up') ? -1 : keys.matches(data, 'tui.select.down') ? 1 : 0;
      if (offset === 0 || tasks.length < 2) return;
      const index = tasks.findIndex((task) => task.id === selectedId);
      selectedId = tasks[(index + offset + tasks.length) % tasks.length].id;
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
