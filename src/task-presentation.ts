export function formatDuration(startedAt: string, finishedAt?: string, now = Date.now()): string {
  const elapsed = (finishedAt === undefined ? now : Date.parse(finishedAt)) - Date.parse(startedAt);
  const seconds = Math.floor(Math.max(0, elapsed) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
