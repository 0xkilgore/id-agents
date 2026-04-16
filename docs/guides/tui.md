# TUI Dashboard

The TUI is a live terminal dashboard for the running team. It polls the manager over HTTP and renders the agents table, the per-agent news feed, and a news-item detail view in the terminal alt-screen. Read-only — no commands are dispatched from the TUI.

Source lives in `src/tui/`. Entry point: `src/tui/index.tsx`.

## Launching

Two run modes are wired into `package.json`:

```bash
npm run tui:dev          # source mode — runs src/tui/index.tsx via tsx
npm run tui:build        # compile to dist/tui/
npm run tui              # build + run dist/tui/index.js
```

Use `tui:dev` while iterating. Use `tui` for a stable run from the built artifact.

The TUI requires a real TTY. It enters the terminal alt-screen on launch and restores the main screen on exit. `q` or `Ctrl+C` quits cleanly.

## Pages

The TUI has three pages and one navigation model — left/right moves between pages, up/down moves the selection within a page.

| Page | Shows |
|------|-------|
| `agents` | All agents across teams. Status strip at the top, team filter row, agent table |
| `news` | News feed for the agent selected on the agents page |
| `news-detail` | Full content of the news item selected on the news page |

The flow is `agents → news → news-detail`. `←` (or `Esc`) walks back one step.

## Keybindings

Global:

| Key | Action |
|-----|--------|
| `q` or `Ctrl+C` | Quit |
| `p` | Pause polling (also pauses the news feed cooldown timer) |

Agents page:

| Key | Action |
|-----|--------|
| `↑` `↓` | Move selection |
| `PgUp` `PgDn` | Page through the table |
| `Home` `End` | Jump to first / last agent |
| `Tab` | Cycle to next team filter |
| `Shift+Tab` | Cycle to previous team filter |
| `→` | Open the selected agent's news feed |

News page:

| Key | Action |
|-----|--------|
| `↑` `↓` | Move selection |
| `PgUp` `PgDn` | Page through the feed |
| `Home` `End` | Jump to newest / oldest item |
| `→` | Open the selected news item in detail view |
| `←` or `Esc` | Back to the agents page |

News-detail page:

| Key | Action |
|-----|--------|
| `↑` `↓` | Scroll one row |
| `PgUp` `PgDn` | Scroll one page |
| `Home` `End` | Jump to top / bottom |
| `←` or `Esc` | Back to the news page |

## Polling

The TUI polls the manager on three independent intervals:

| Source | Interval | Endpoint |
|--------|----------|----------|
| Teams | 15 s | `GET /teams` |
| Agents (all teams) | 2 s | `GET /agents?team=<name>` per team |
| News (selected agent) | 3 s | `POST /remote` with `/news <agent>` |

Press `p` to pause every poller. Pause also freezes the cooldown timer rendered on the news page.

The agents fetcher filters out rows where `type === 'interactive'` so the manager itself does not appear as an agent.

## Terminal Compatibility

iTerm2 on macOS is the confirmed flicker-free terminal. The TUI patches stdout to rewrite Ink's per-render erase sequences (`ESC[2K ESC[1A` and the `clearTerminal` fallback) into a single cursor-home so cells are overwritten in place. Without this, iTerm2 paints a visible blank frame on every keypress.

Other modern terminal emulators (Alacritty, Kitty, WezTerm, Windows Terminal) generally work, but flicker behavior depends on how each emulator handles the alt-screen + erase sequences. If you see flashing on selection changes, file an issue with the terminal name and version.

`tmux` and `screen` work as long as the outer terminal is in alt-screen-friendly mode.

## Static Mode

Pass `--static` (or `--no-poll`) for a one-shot snapshot that fetches teams + agents once and renders without polling:

```bash
npm run tui:dev -- --static
```

Static mode is useful for screenshots and for scripted captures where you do not want a live feed.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGER_URL` | `http://localhost:4100` | Manager base URL the TUI polls |

Set `MANAGER_URL` to point at a remote manager — for example to watch a deployed team from a laptop:

```bash
MANAGER_URL=https://idbot.live npm run tui:dev
```

The TUI never authenticates. Point it only at managers you trust on networks you control.
