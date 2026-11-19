import { replaceControlCharacters, stripTerminalSequences } from '@earendil-works/pi-tui';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const LOG_REFRESH_MS = 250;

export function plainText(text: string): string {
  return replaceControlCharacters(stripTerminalSequences(text));
}

export async function readLogTail(path: string, maxBytes: number, maxLines: number): Promise<string[]> {
  // The job may replace the log entry. Don't follow a final symlink or block on a FIFO.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Log is not a regular file');
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, stat.size - buffer.length);
    if (bytesRead === 0) return [];
    const text = stripTerminalSequences(buffer.toString('utf8', 0, bytesRead));
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '')
      .split('\n').slice(-maxLines).map(replaceControlCharacters);
  } finally {
    await file.close();
  }
}
