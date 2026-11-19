import { CONFIG_DIR_NAME, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createTasks, MAX_TIMEOUT_SECONDS } from './tasks.ts';

const notificationType = 'background-task-notification';

// Quote paths and names so they stay on one line and cannot close the notification tag.
function quote(value: string): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

export default function (pi: ExtensionAPI) {
  const tasks = createTasks();
  let shuttingDown = false;

  pi.on('session_shutdown', async ({ reason }) => {
    shuttingDown = true;
    await tasks.shutdown(`Pi session ended (${reason})`);
  });

  pi.registerTool({
    name: 'bg_run',
    label: 'Background Bash',
    description: 'Start a named Bash command in the project directory and return immediately with its task ID and log path. By default Pi delivers a completion notification and follows up automatically. Combined stdout and stderr are capped at 20 MiB on disk and never included in the notification.',
    promptSnippet: 'Run long-lived Bash commands without blocking the turn.',
    promptGuidelines: [
      'Use bg_run for long-running builds, tests, and servers. Run the command directly without & or nohup.',
      'After a bg_run launch with default completion settings, do not sleep or poll. Continue independent work or end the turn; Pi will follow up when the job exits.',
      'Read the bg_run output file only when the command output is needed.',
    ],
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 120, description: 'Short human-readable name for the job' }),
      command: Type.String({ minLength: 1, description: 'Command to run with Bash -c' }),
      description: Type.Optional(Type.String({ description: 'Additional context to include in the result file' })),
      timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_TIMEOUT_SECONDS, description: 'Stop and fail the task after this many seconds; omit for no timeout' })),
      notifyOnCompletion: Type.Optional(Type.Boolean({ description: 'Send a completion notification (default true)' })),
      triggerOnCompletion: Type.Optional(Type.Boolean({ description: 'Start a follow-up turn on completion (default true; requires notifications)' })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, options, signal, _onUpdate, ctx) {
      const { task, done } = await tasks.run(ctx.cwd, join(ctx.cwd, CONFIG_DIR_NAME, 'tasks'), options, signal);
      void done.then((result) => {
        if (shuttingDown || !result.notifyOnCompletion) return;
        pi.sendMessage({
          customType: notificationType,
          display: true,
          details: { task: result },
          content: [
            `<${notificationType}>`,
            `Task: ${quote(result.name)} (${result.id})`,
            `Status: ${result.status}`,
            ...(result.exitCode === null ? [] : [`Exit code: ${result.exitCode}`]),
            ...(result.error ? [`Error: ${quote(result.error)}`] : []),
            `Output: ${quote(result.outputPath)}`,
            result.metadataError ? quote(result.metadataError) : `Result: ${quote(result.resultPath)}`,
            `</${notificationType}>`,
          ].join('\n'),
        }, { deliverAs: 'followUp', triggerTurn: result.triggerOnCompletion });
      }).catch((error: unknown) => {
        if (!shuttingDown) ctx.ui.notify(`bg_run completion error: ${String(error)}`, 'error');
      });

      return {
        content: [{ type: 'text', text: [
          `Started background task ${quote(task.name)} (${task.id})`,
          `Status: ${task.status}; PID: ${task.pid}`,
          `Output: ${quote(task.outputPath)}`,
          `Result (written on completion): ${quote(task.resultPath)}`,
          task.triggerOnCompletion ? 'Pi will follow up on completion; do not poll or sleep to wait.' :
            task.notifyOnCompletion ? 'A completion notification will be displayed without starting a turn.' :
              'Completion notifications are disabled.',
        ].join('\n') }],
        details: { task },
      };
    },
  });
}
