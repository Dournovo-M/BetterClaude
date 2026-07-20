# Better-Claude

A local task queue for [Claude Code](https://claude.com/claude-code).

Queue up prompts as cards. A tiny server runs them **one at a time**, each in
the directory you chose, while you do something else. Finished tasks land in a
review column: validate, or send a one-line follow-up that **resumes the same
Claude session** instead of starting over.

The whole interface is a keyboard-only TUI. No web page, no browser, no
database — a Node server, three folders, and a green-on-black terminal.

## Why

Claude Code is interactive: one terminal, one conversation, you babysit it.
Better-Claude turns it into a queue. Write five prompts, walk away, come back
to five diffs waiting for review. Because follow-ups reuse `--resume`,
"actually, make the button red" costs one line, not a re-explanation of the
whole task.

## Security — read this first

Tasks run with **`--dangerously-skip-permissions`**: Claude gets full file,
shell and network access inside the working directory you picked, with no
confirmation prompts. That is the point of the tool — and its main risk.

Guard rails:

- One task runs at a time, with a 1-hour hard timeout per run.
- Nothing is auto-validated: every result waits in the review column for you.

If that trade-off is not acceptable on your machine, don't use this tool.

## Requirements

- Node.js ≥ 18
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code),
  installed and logged in (`claude` must work in your terminal)
- macOS for the TUI (clipboard image paste uses `osascript`); the server and
  API are cross-platform
- Optional: [opencode](https://opencode.ai), only if you want to drive
  non-Claude CLIs through the API

## Quick start

```bash
git clone https://github.com/Dournovo-M/BetterClaude.git
cd BetterClaude
npm install          # one dependency, for the TUI (neo-blessed)
node server.js
```

In another terminal:

```bash
./cli.sh
```

Type a prompt, press `Enter`, and watch the card move across the board.

## Keyboard reference

The board is a grid — arrows move between cells like a spreadsheet: prompt on
top, model/folder row below it, then the three columns.

| Key | Action |
|---|---|
| `↑` `↓` `←` `→` | move between cells; inside a column, `↑`/`↓` walk the cards |
| `Enter` | prompt: submit · card: open it · explorer: enter the folder |
| `Shift+Enter` | newline in the prompt (on terminals that distinguish it: iTerm2, kitty…) |
| `1` / `2` / `3` | jump to Scheduled / To review / Finished |
| `m` | pick a Claude model |
| `w` | pick the working directory in a mini file explorer |
| `Ctrl+V` | paste a clipboard image, attached to the next task |
| `Esc` | close a popup |
| `Ctrl+C` | quit |

Opening a card shows the original prompt, follow-ups, the live log (tool
calls, text, errors) and the actions: **validate**, **follow-up** (resumes the
session), **delete**.

## How it works

Three folders are the entire state machine. A task is one JSON file that moves
between them — no database, so `tasks/` is inspectable, greppable and
deletable with normal shell tools:

```
tasks/scheduled/            queued or running (FIFO)
tasks/waiting-for-review/   done, awaiting your verdict
tasks/finished/             validated
```

The runner picks the oldest `queued` task as soon as nothing is running,
spawns `claude -p` in the task's cwd, and streams tool calls and text into
the card's log.

A task file looks like this:

```json
{
  "id": "1783867052600-b1x6",
  "cwd": "/path/to/project",
  "original_prompt": "…",
  "followups": [{ "prompt": "…", "at": "…" }],
  "runs": [{ "log": ["…"], "result": "…", "cost_usd": 0.08, "resumed": false }],
  "session_id": "…",
  "status": "queued | running | ok | error | stopped | validated"
}
```

## License

MIT — see [LICENSE](LICENSE).
