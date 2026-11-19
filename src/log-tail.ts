import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { replaceControlCharacters, stripTerminalSequences } from "@earendil-works/pi-tui";

export const LOG_REFRESH_MS = 250;

export function plainText(text: string): string {
  return replaceControlCharacters(stripTerminalSequences(text));
}

export interface LogTail {
  lines: string[];
  clipped: boolean;
}

export async function readLogTail(path: string, maxBytes: number, maxLines: number): Promise<LogTail> {
  // The job may replace the log entry. Don't follow a final symlink or block on a FIFO.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Error("Log is not a regular file");
    }
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const offset = stat.size - buffer.length;
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) {
      return { lines: [], clipped: offset > 0 };
    }
    let start = 0;
    // A byte-limited tail can start inside a UTF-8 character.
    if (offset > 0) {
      while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) {
        start++;
      }
    }
    const text = stripTerminalSequences(buffer.toString("utf8", start, bytesRead));
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n");
    return {
      lines: lines.slice(-maxLines).map(replaceControlCharacters),
      clipped: offset > 0 || lines.length > maxLines,
    };
  } finally {
    await file.close();
  }
}
