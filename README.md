# OSA Control

[Deutsch](README.de.md)

A local dashboard for Claude Code and Codex sessions: tasks, outcomes, token usage,
estimated activity and next-step notes for unfinished work.

## Safe demo

Requires Node.js 22.6+ with TypeScript stripping and npm. Checked with Node.js 24.15.0.

```sh
npm ci
npm run demo
```

Open http://127.0.0.1:3000. Synthetic sessions are dated August 19, 2026. No API key
or model service is required. Demo mode ignores personal source configuration and
parser root overrides. Missing demo files never fall back to personal sessions.

Production preview (POSIX shell syntax):

```sh
npm run build
DASHBOARD_DEMO=1 npm start
```

This Node.js app cannot run on static GitHub Pages; a separate portfolio can present it.
Demo resume commands reference fictional paths and IDs, not real resumable sessions.

## Features and architecture

- Claude Code and Codex JSONL parsing, daily recaps and seven-day task overview.
- Date, agent, subagent, scope and text filters.
- Open, blocked and done states, next-step notes and copyable resume commands.

```text
JSONL sources -> session parser -> daily aggregation -> server-rendered UI
                                                    |
                                local action -> work-state JSON
```

`app/page.tsx` renders the dashboard. `lib/sessions.ts` normalizes events and caches
parsed sessions using file size and modification time. `lib/work-state.ts` validates
states and notes and saves them using atomic file replacement. `app/actions.ts`
handles local updates. Forms adopt saved values when their server state changes.

Demo sources: `demo/claude`, `demo/codex`; demo state: `.data/demo-work-state.json`.
Normal mode uses separate sources and defaults to `.data/work-state.json`.
Runtime data, dependencies and build files are excluded from version control.

## Personal local use

`npm run dev` reads `~/.claude/projects` and `~/.codex/sessions` by default. These
may include private and professional conversations. Only use authorized sources;
use the demo for screenshots, screen sharing and public demonstrations.

| Variable | Purpose |
|---|---|
| `CLAUDE_PROJECTS_DIR` | Claude Code session root |
| `CODEX_SESSIONS_DIR` | Codex session root |
| `DASHBOARD_STATE_FILE` | Work-state file |
| `DASHBOARD_TIME_ZONE` | Reporting timezone; default `Europe/Berlin` |
| `DASHBOARD_DEMO` | `1` enables synthetic sources and separate demo state |

Demo mode ignores the first three variables. The app binds to localhost and reads
session sources server-side without modifying them. Normal mode does not redact
session text. Do not expose it through a public interface or tunnel: there is no
multi-user authentication layer.

## Checks and limits

`npm run check` runs TypeScript checking, parser/state/demo tests and a production
build. Tests use synthetic inputs and temporary state rather than personal sources.
GitHub Actions runs the same check on pushes and pull requests.

Activity is estimated from event gaps capped at ten minutes, not a timesheet.
Liveness is based on file modification time; copied fixtures may appear active.
Token totals are not an invoice. Source formats can change; malformed or unreadable
sessions can be skipped. Atomic state writes do not coordinate concurrent edits.
The dashboard does not implement RAG or model inference.

Publication rights and licensing must be settled before distributing the code.
