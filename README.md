# Project Launcher

A desktop app (Electron) that lists every project in `Documents/projetos`, shows its git status, and opens or starts it with one click.

```
npm install
npm start
```

## What it does

- **Finds projects.** It walks the projects folder. Any folder with a marker (`.git`, `package.json`, `Cargo.toml`, `*.sln`, `pyproject.toml`, `*.py`, `index.html`, …) counts as a project. A folder without one, like `react/` or `python/`, becomes a category.
- **Detects commands**:
  - npm/pnpm/yarn scripts, including `client/`, `server/`, `frontend/` sub-apps
  - `cargo run`, `dotnet run --project …`, `go run`, `docker compose up`
  - Python scripts and `[project.scripts]` entry points, using the project's `venv` if it has one
  - `jupyter lab` for notebook folders
  - static `index.html` pages, opened in the browser

  The ▶ default prefers dev/start commands. Click ○ to change it, or add your own command.
- **Git status**: branch, ↑ahead/↓behind, uncommitted file count and list, last commit. It refreshes when the window gets focus. It never fetches, so ahead/behind is as of your last `git fetch`.
- **Process management**: streams logs live, detects `http://localhost:…` URLs, and shows exit codes. Stop kills the whole process tree. Closing the window with servers running asks before quitting.
- **Open in** your editor (`code` by default, configurable), Explorer, or Windows Terminal.

- **Add to portfolio**: the ✦ button writes an entry for the selected project into your portfolio site (`content/projects/<slug>.json` in its local clone, found automatically or set in Settings). The form is pre-filled from `package.json`, the README, the git remote, the first commit date and the detected stack. You fill in the Portuguese text and pick a category or zodiac constellation. Saving runs the portfolio's own `npm run validate`, and a failed check leaves no file behind. Nothing is committed or pushed: you review and publish the portfolio yourself. Projects already in the portfolio are marked ✦ in the list.

Shortcuts: `/` search · `↑/↓` select · `Enter` run default · `e` editor · `t` terminal · `Ctrl+R` rescan.

## How it's built (the learning part)

```
src/
  main/            ← Node side: full OS access
    main.js        window, IPC handlers, app lifecycle
    projects.js    folder scan + command detection
    git.js         `git status --porcelain=v2` parsing, concurrency limiter
    processes.js   child processes, log buffering, kill-tree
    settings.js    JSON file in %APPDATA%/project-launcher
    portfolio.js   "Add to portfolio": prefill, write the entry, run the site's validator
  preload.js       the bridge: exposes a small `window.api`
  renderer/        ← browser side: plain HTML/CSS/JS, sandboxed
```

Things worth reading in the code:

1. **Process isolation.** The renderer runs with `contextIsolation`, `sandbox`, and no Node. It can only call the functions in `preload.js`. The main process re-checks every project path against its last scan, so the UI can't run arbitrary commands in arbitrary folders.
2. **Killing process trees** (`processes.js`):
   - With `shell: true`, `npm run dev` becomes `cmd.exe → npm → node → vite`. Killing the PID you got back only kills `cmd.exe`, which orphans vite and leaves port 5173 busy.
   - On Windows the app uses `taskkill /T /F`. On macOS/Linux it spawns the process `detached`, which gives it its own process group, then kills `-pid`.
3. **Streaming output.** Output arrives in arbitrary chunks, so it is split into lines while the partial last line is kept for the next chunk. Lines are kept in a ring buffer per run and sent to the UI in 50 ms batches, so a noisy server can't flood IPC.
4. **Lifecycle.** The app is single-instance (`requestSingleInstanceLock`). It confirms on close while processes are running, and does a synchronous kill in `will-quit` so nothing outlives the launcher.

## Tests

```
npm test
```

The tests cover git output parsing, project detection on a temp folder tree, output capture with URL detection, and a kill-tree test. That test spawns a grandchild process and checks it is really dead after Stop.
