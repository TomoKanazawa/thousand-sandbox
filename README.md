# Thousand Sandbox

An exact working copy of any web app, as a sandbox for testing AI agents.

You point it at a web app you can log in to. It records the app, builds a local copy that serves the app's own
front-end at the app's original URLs, and tells you which actions in the copy are proven and which are not. Your
agent then runs against the copy instead of the real thing: no client access needed, nothing real gets changed,
and a reset takes under a second.

It runs on your machine. Nothing is sent to us. The only outside call is to Anthropic, with your own API key,
and only when you run `sandbox build`.

**Status: early.** Everything below works on the test app in this repo and passes its tests. It has not yet been
run on a large real app. See [docs/STATUS.md](docs/STATUS.md) for what is built and what is not.

## Quick start

```bash
pnpm install && pnpm build
alias sandbox="node $PWD/packages/sandbox/dist/cli.js"

sandbox init https://app.example.com     # opens Chrome with its own profile; log in, close the window
sandbox capture                          # use the app as usual, close the window when done
sandbox up                               # the copy is running; a Chrome window opens on it
```

`sandbox up` prints a DevTools address. Any agent framework that can attach to a running Chrome (Playwright,
Browser Use, Stagehand, Puppeteer) uses the copy at the app's real URLs with no code change:

```ts
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
```

## Two kinds of copy

| | Replay copy | Stateful copy |
|---|---|---|
| Made by | `sandbox capture` | `sandbox build` (a coding agent, your API key) |
| Reads | Exactly what was recorded | Any record, from a database |
| Writes | Answered as recorded; nothing changes | Change the database; later reads show it |
| Never-recorded request | `501` with `X-Sandbox: uncaptured` | Same |
| Cost | Free | Model usage, capped by `--max-usd` |

## Commands

| Command | What it does |
|---|---|
| `sandbox init <url>` | Set up an app under `.sandbox/` and log in once |
| `sandbox capture` | Record your own session. `--explore` crawls by itself with writes blocked |
| `sandbox policy` | Show or change which endpoints count as reads and which as writes |
| `sandbox scrub` | Strip secrets; `--pii` also replaces personal data; `--review` shows the result |
| `sandbox analyze` | Group requests into endpoints and classify them. No model |
| `sandbox build` | Generate the database and handlers, then check them |
| `sandbox verify` | Check the copy against the recordings. No model |
| `sandbox report` | The ledger: which endpoints and actions are verified, replayed-only, inferred or uncaptured |
| `sandbox up` / `reset` / `down` | Run the copy, restore its data, stop it |
| `sandbox drift` | Re-check the live app, read-only, and report what changed. `--update` refreshes the copy |
| `sandbox schedule daily` | Run the drift check every day |
| `sandbox doctor` | Check this machine |

While the copy runs, a control port answers `POST /reset`, `GET /state` (the database as JSON, for test
assertions), `GET /log` (every request your agent made, including uncaptured ones) and `GET /ledger`.

## How it stays honest

- **Labels.** Each endpoint gets one: *verified* (it answered correctly for a record the builder never saw, or a
  read after a write matched), *replayed-only* (it reproduces one recording), *inferred*, *uncaptured*, *external*.
- **The builder never sees the test.** Half the recorded instances of each endpoint are held back. Only
  deterministic code compares the copy with the recordings; a model writes code but never grades it.
- **Exploration cannot write.** Two independent gates: one judges the control before a click, one judges the
  request before it leaves the browser. Unknown requests other than GET are blocked by default.
- **Secrets never reach the model.** Cookies, tokens and passwords are replaced by placeholders before analysis.

## Everything is a file you can edit

`.sandbox/<app>/` holds the recordings, `policy.yaml`, the analysis, and the copy itself: `schema.sql`, `seed.sql`,
one TypeScript file per endpoint under `routes/`, and `ledger.json`. Formats are in
[docs/FORMATS.md](docs/FORMATS.md); the handler contract is in [docs/CONTRACT.md](docs/CONTRACT.md). If the copy
is wrong for your app, fix the file and run `sandbox verify`.

## Develop

```bash
pnpm install
pnpm --filter thousand-sandbox exec playwright install chromium
pnpm build && pnpm test
node fixtures/tiny-clinic/server.mjs      # the test app, http://127.0.0.1:4010
```

Requires Node 22.13+, pnpm 9 and Google Chrome. The builder needs `@anthropic-ai/claude-agent-sdk` and
`ANTHROPIC_API_KEY`.

## Rules for this repo

- Never commit captures, HAR files, certificates or keys (`.sandbox/` is git-ignored).
- No recordings of other companies' software and no bot-detection evasion in this repository.
- Development targets are the test app here or our own test systems with fictional data.

## Licence

Apache-2.0. The Claude Agent SDK, used by `sandbox build`, is a separate product under Anthropic's terms.
