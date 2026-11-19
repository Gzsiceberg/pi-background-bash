# pi-background-bash

A standalone Pi extension for background Bash jobs. Ask the agent to launch a job with `bg_run`, then watch it with `/bg-tasks`.

## Install

From this checkout:

```sh
pi -e ./src/extension.ts  # Try it for one invocation
pi install "$PWD"        # Or install it persistently
```

Tested with Pi 1.5.2 on macOS. The runtime requires a POSIX host with `bash` on `PATH`; native Windows is not supported. Don't load this alongside `pi-background-tasks` as both register `bg_run`.

## Let the agent start a job

Ask Pi to run a command in the background, for example: “Run `npm test` in the background and tell me when it finishes.” The `bg_run` tool call would look like:

```json
{"name":"Run project tests","command":"npm test","timeoutSeconds":300}
```

`name` and `command` are required. `description` and `timeoutSeconds` are optional. Omitting the timeout lets the job run until it finishes or the Pi session ends.

- `bg_run` returns the task ID, PID, and paths to `output.log` and `result.json` under `.pi/tasks/<task-dir>/` in the current project. `output.log` captures both stdout and stderr. At completion, `result.json` records `completed`, `failed`, or `killed` and the exit code or signal.
- By default `bg_run` displays a completion notification and starts a follow-up turn. No polling is needed. Set `triggerOnCompletion: false` to display the notification without starting a turn, or `notifyOnCompletion: false` to disable both. The notification does not include command output; read `output.log` when you need it.
- In interactive Pi, type `/bg-tasks` to see job names, statuses, and shell output. Running jobs come first. Use **↑/↓** to select a job and **Esc** to close the panel. A completion notification shows the outcome and duration, plus a `/bg-tasks <id>` command that selects that job directly. The panel keeps the last 20 finished jobs in the current activation.
- **Page Up** pauses the selected log and scrolls back; **Page Down** scrolls forward without resuming. Press **End** to jump back to the latest output. The preview shows up to 12 lines at once, marks clipped output, and holds up to 2,000 lines from the last 128 KiB. Press **p** to view the full log path (press **p** or **Esc** to return); open that file or use `tail -f` to see more. The preview is UI-only.
- To stop the selected running job, press **x**, then **y** to confirm (**n** or **Esc** cancels). A stopped job is recorded as `killed` and follows its usual completion notification settings.
- While jobs are running, the footer shows their count and a `/bg-tasks` hint. No live output is shown unless you open the panel.
- Run `command` directly, without `&` or `nohup`. It runs as `bash -c` in Pi's working directory with the inherited environment and no interactive stdin. It is not sandboxed.
- A job fails if it exceeds 20 MiB of combined output or its timeout. On normal Pi exit, session replacement, or reload, Pi sends `SIGKILL` to the process group of each still-running job, saves its result as `killed`, and suppresses completion notifications. Jobs aren't resumed. If Pi is force-killed, cleanup isn't guaranteed; processes that detach from the group are also outside Pi's control. Logs remain on disk and may contain secrets; keep `.pi/tasks/` out of version control.

Inspired by [`bg_run` in pi-background-tasks](https://pi.dev/packages/pi-background-tasks?name=background). This is the Bash-only subset: it does not support upstream `isAgent` telemetry or `surviveReload`.

## Develop

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
```

Run `npm run format` to apply Prettier formatting to `src/`, `tests/`, and `eslint.config.mjs`. ESLint requires braces around control-flow bodies, even for a single statement. Run `npm run lint -- --fix` to add missing braces automatically, then run `npm run format`.

The test suite uses a scripted Pi provider; it does not require an API key or a live model.
