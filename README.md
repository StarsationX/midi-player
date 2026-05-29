# MIDI Player

Plays MIDI files into any Windows app (Roblox piano games, [virtualpiano.net](https://virtualpiano.net), etc.) by simulating keypresses, with a real-time piano-roll visualizer, low-latency timing, global hotkeys, and a built-in pause/resume.

Built as an Electron front-end with a Python sidecar for the keypress engine.

---

## Features

- **Drag-and-drop**: drop a `.mid` / `.midi` file anywhere on the window to load it; drop a `.json` to load a custom mapping.
- **Built-in visualizer**: piano-roll + virtual keyboard, smoothly tweened to the song's tempo (no teleporting between updates).
- **YouTube-style scrubber**: click, drag, or use ←/→/Home/End on the progress bar to seek anywhere in the track — even mid-playback.
- **Pause / Resume**: F8 by default, or click the on-screen button.
- **Global hotkeys**: Play (F6), Stop (F7), Pause (F8) — work even when the game has focus.
- **Auto-pause on focus loss**: if you tab out of the target window, playback freezes; tab back in to resume.
- **Tempo control** (0.25× – 3×) and optional pre-roll countdown (disabled by default).
- **Timing stats**: per-note error histogram for tuning.
- **High-resolution timing on Windows**: `timeBeginPeriod(1)`, thread-priority boost, GC disabled during playback, hybrid sleep + 3 ms busy-wait spin.
- **Multiple mapping presets** for the popular layouts (see below).
- **Portable build**: PyInstaller bundles the Python sidecar into a single `.exe` so end users don't need Python installed — see [Build a portable .exe](#build-a-portable-exe).

## Mapping presets

| Preset | Range | Notes |
|---|---|---|
| `roblox` | MIDI 36–96, 36 keys | `1`…`m` no Shift — white-only layout used by most Roblox piano games. Sharps collapse to the nearest white. |
| `roblox61` | MIDI 36–96, 61 keys | Standard 61-key piano with `Shift` for sharps. |
| `roblox66` | MIDI 31–96, 66 keys | 61-key + 5 extra low notes on `; : ' " ,`. |
| `roblox88` | MIDI 21–108, 88 keys | Full 88 keys, low/high extensions on unused symbols/letters. |
| `roblox88ctrl` | MIDI 21–108, 88 keys | Full 88 keys, low/high extensions on `Ctrl+1`…`Ctrl+j`. |
| `virtualpiano` | MIDI 36–96+, 88 keys | virtualpiano.net layout. |
| `virtualpiano66` | MIDI 36–96, 66 keys | virtualpiano.net 66-key layout. |

You can also drop your own `mapping.json` — same schema as the bundled ones in `python-engine/mappings/`. Values are single chars (`"a"`, `"!"`) or modifier combos (`"ctrl+1"`, `"ctrl+shift+a"`).

---

## Requirements

- **Windows 10 / 11** (uses Win32 for focus tracking + high-resolution timer; macOS path exists but is less tested)
- **Node.js 18+** and **npm**
- **Python 3.10+**

## Install

```powershell
git clone https://github.com/StarsationX/midi-player.git
cd midi-player
```

Then **double-click `install.bat`** — it checks Node + Python are on PATH, runs `npm install`, and `pip install -r python-engine/requirements.txt`.

Or do it manually:

```powershell
npm install
pip install -r python-engine/requirements.txt
```

## Run

Double-click **`start.bat`**, or:

```powershell
npm start
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Python is missing the "pynput" module` | Run `install.bat` (or `pip install -r python-engine/requirements.txt`) and restart the app. |
| `Couldn't find Python. Tried: py -3, python, python3` | Install Python 3.10+ from https://python.org and tick **"Add python.exe to PATH"**. Alternatively set the `PYTHON` env var to the full path of your `python.exe`. |
| `Failed to spawn Python` on macOS / Linux | Set `PYTHON=python3` (or your interpreter's path) in your shell and relaunch. |
| Keys go to the wrong window | Make sure you re-focus the target window during the 3-second countdown. The status pill turns red when focus is lost. |

Then in the window:

1. **Browse** a `.mid` file (or drag one in).
2. **Refresh** the target-window dropdown and pick the game / browser tab.
3. Pick a **mapping** that matches the game.
4. (Optional) tweak tempo / countdown / hotkeys.
5. Click **▶ Play** (or press **F6**). Focus the target window during the countdown — playback auto-pauses if focus is lost.

Hotkeys (work globally):

- **F6** — Play (or Resume if currently paused)
- **F7** — Stop
- **F8** — Toggle pause / resume

## Build a portable .exe (zero-install)

```powershell
npm run build:portable
```

Produces a single **`dist/MIDI Player 1.0.0.exe`** (~80 MB) — double-click to run, no install, no admin, no Python needed. Ship that one file to your friends.

What it does:
1. Builds the Python sidecar into `python-engine/ipc_main.exe` via PyInstaller (~11 MB self-contained).
2. Builds the Electron app into `dist/win-unpacked/` (via `electron-builder --win --x64 -c.win.target=dir`).
3. Wraps that into a single self-extracting `.exe` via `electron-builder --prepackaged dist/win-unpacked ... -c.win.target=portable`.

The two-pass build is intentional: doing the portable target in one shot tries to extract code-signing tools that contain macOS symlinks, which Windows blocks without admin/Developer Mode. Splitting into a dir-build + a prepackaged wrap sidesteps that entirely.

### Alternative: a portable ZIP

```powershell
npm run build:zip
```

Same end result, distributed as `dist/MIDI-Player-portable.zip` (~118 MB compressed). Useful if your friends prefer to inspect the folder contents or run via a USB stick.

### Build an installer (registers in Start Menu)

```powershell
npm run build:win
```

Produces an NSIS installer in `dist/`.

---

## Architecture

```
midi-player-app/
├─ src/
│  ├─ main.js          Electron main process, spawns Python sidecar
│  ├─ preload.js       contextBridge: send(), pickMidi(), webUtils.getPathForFile(), …
│  └─ renderer/
│     ├─ index.html
│     ├─ style.css
│     ├─ app.js        DOM glue, settings persistence, hotkey routing
│     └─ visualizer.js Canvas piano-roll with extrapolating local clock
└─ python-engine/
   ├─ ipc_main.py      JSON-over-stdio bridge (newline-delimited)
   ├─ midi_player.py   parsing, mapping, focus monitor, playback loop
   ├─ requirements.txt
   └─ mappings/*.json
```

**IPC protocol** (newline-delimited JSON in both directions, see top of `ipc_main.py`):

- Renderer → Python: `list_windows`, `load_midi`, `play`, `stop`, `pause`, `resume`, `toggle_pause`, `set_hotkeys`, `shutdown`
- Python → Renderer: `ready`, `windows`, `log`, `midi_loaded`, `countdown`, `playback_started`, `progress`, `playback_done`, `hotkey`, `error`

**Timing model**: events are pre-computed at load time. The hot playback loop runs on a single Python thread with raised priority, GC disabled, and a 1 ms timer resolution. Inter-note sleep is split into ≤25 ms slices so user pause / focus-loss is honoured within ~25 ms even during long gaps; the last 3 ms of each note is a busy-wait spin for sub-millisecond accuracy.

**Visualizer clock**: Python emits a progress packet every 50 ms with `elapsed`, `frozen_elapsed`, and a Python `perf_counter()` reference. The JS renderer extrapolates between packets using `performance.now()`, freezing on `frozen_elapsed` while paused — so notes scroll at the exact tempo instead of jumping each packet.

---

## License

MIT — see [LICENSE](./LICENSE).
