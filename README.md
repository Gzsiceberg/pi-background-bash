# pi-background-bash

Run Bash commands in the background without blocking Pi. Start a test suite, build, or other long-running command and keep working while it runs.

## Install

From the root of this repository, run:

```sh
pi install "$PWD"
```

Requires a POSIX host with `bash` on `PATH`. Native Windows is not supported.

## Use

Ask Pi: “Run `npm test` in the background and tell me when it finishes.” Pi uses `bg_run` to start the job and notifies you when it finishes.

- Open `/bg-tasks` to see all running jobs and the last five finished jobs. There is no limit on running jobs, and older logs stay on disk. Use **↑/↓** to select a job and **Esc** to close the panel.
- To stop a running job, select it and press **x**, then **y** to confirm.
- Each job has a short ID, such as `b1a9a24d`. Open it directly with `/bg-tasks b1a9a24d`. Full output is saved under `.pi/tasks/<id>/` in the working directory. Running jobs stop when the Pi session ends.

## License

[MIT](LICENSE)
