# pi-background-bash

A standalone Pi extension that adds only `bg_run`. Use it to start a long-running Bash command without blocking Pi. There are no additional tools, slash commands, or task dashboards.

## Install

From this checkout:

```sh
pi -e ./src/extension.ts  # Try it for one invocation
pi install "$PWD"        # Or install it persistently
```

Tested with Pi 1.5.2 on macOS. The runtime requires a POSIX host with `bash` on `PATH`; native Windows is not supported. Don't load this alongside `pi-background-tasks` as both register `bg_run`.

## Use

Ask Pi to run a command in the background, for example: “Run `npm test` in the background and tell me when it finishes.” The `bg_run` tool call would look like:

```json
{"name":"Run project tests","command":"npm test","timeoutSeconds":300}
```

`name` and `command` are required. `description` and `timeoutSeconds` are optional. Omitting the timeout lets the job run until it finishes or the Pi session ends.

- `bg_run` returns the task ID, PID, and paths to `output.log` and `result.json` under `.pi/tasks/<task-dir>/` in the current project. `output.log` captures both stdout and stderr. At completion, `result.json` records `completed`, `failed`, or `killed` and the exit code or signal.
- By default Pi displays a completion notification and starts a follow-up turn. No polling is needed. Set `triggerOnCompletion: false` to display the notification without starting a turn, or `notifyOnCompletion: false` to disable both. The notification does not include command output; read `output.log` when you need it.
- Run `command` directly, without `&` or `nohup`. It runs as `bash -c` in Pi's working directory with the inherited environment and no interactive stdin. It is not sandboxed.
- The job fails if it exceeds 20 MiB of combined output or its timeout. Pi stops the job's process group in either case and on session exit, replacement, or reload. Processes that detach from the group are outside its control. Logs are retained on disk until you remove them and may contain secrets; keep `.pi/tasks/` out of version control.

Inspired by [`bg_run` in pi-background-tasks](https://pi.dev/packages/pi-background-tasks?name=background). This is the Bash-only subset: it does not support upstream `isAgent` telemetry or `surviveReload`.

## Develop

```sh
npm ci
npm run typecheck
npm test
```

The test suite uses a scripted Pi provider; it does not require an API key or a live model.
