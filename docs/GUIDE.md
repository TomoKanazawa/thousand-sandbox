# Guide: using Thousand Sandbox on your own app

Read [TUTORIAL.md](TUTORIAL.md) first if you have not run the tool yet. It takes 15 minutes on a bundled test
app and shows every part working. This guide is the reference for doing the same on a real app.

The tool is early. It has been run on its test app and one simple public site, not yet on a large real app.
[STATUS.md](STATUS.md) lists what is built and what is missing. Expect rough edges and please report them.

## Contents

1. [What you get](#1-what-you-get)
2. [Before you start](#2-before-you-start)
3. [Install](#3-install)
4. [Set up an app](#4-set-up-an-app)
5. [Record the app](#5-record-the-app)
6. [Run the copy and attach an agent](#6-run-the-copy-and-attach-an-agent)
7. [Make the copy keep state](#7-make-the-copy-keep-state)
8. [Know what to trust](#8-know-what-to-trust)
9. [Keep up with the real app](#9-keep-up-with-the-real-app)
10. [Secrets and personal data](#10-secrets-and-personal-data)
11. [Command reference](#11-command-reference)
12. [Files](#12-files)
13. [Troubleshooting](#13-troubleshooting)
14. [Limits](#14-limits)

## 1. What you get

You point the tool at a web app you can log in to. It records the app while it is used, then runs a local copy
that serves the app's own pages and scripts at the app's own addresses. Your agent works in the copy instead of
the real app.

There are two kinds of copy:

| | Replay copy | Stateful copy |
|---|---|---|
| Made by | `sandbox capture` | `sandbox build` |
| Needs a model | No | Yes, with your Anthropic API key |
| Reads | Exactly the pages and records that were recorded | Any record, from a database |
| Writes | Answered as they were recorded; nothing changes | Change the database; later reads show it |
| Something never recorded | Status `501`, header `X-Sandbox: uncaptured` | The same |
| Cost | Free | Model usage, capped by `--max-usd` |

The copy never makes an answer up. If it has nothing recorded for a request, it says so.

## 2. Before you start

- **You need an account on the app** and the right to use it this way. Recording an app captures its pages and
  data onto your machine. Check the app's terms and your agreement with whoever owns the data.
- **Use a test account or a test record if you can.** A person's recording session does whatever that person
  does, including real changes.
- **Everything stays on your machine.** The tool sends nothing anywhere, with one exception: `sandbox build`
  sends recorded pages and responses (with secrets removed) to Anthropic, using your API key.
- **The tool does not get around bot detection, CAPTCHAs or multi-factor login.** A person logs in; the tool
  reuses that session.

## 3. Install

Requirements: Node 22.13 or newer, pnpm 9 or newer, Google Chrome. Tested on macOS; Linux should work; Windows
is untested. It is not on npm yet, so install from the repository:

```bash
git clone https://github.com/TomoKanazawa/thousand-sandbox.git
cd thousand-sandbox
pnpm install
pnpm build
```

The command is `bin/sandbox` in the clone. Call it by its full path from the folder where you want the tool to
keep its files, or add an alias:

```bash
alias sandbox=/absolute/path/to/thousand-sandbox/bin/sandbox
sandbox doctor
```

`sandbox doctor` checks Node, Chrome, the API key, memory and disk. The API key and the Claude Agent SDK are
needed only for `sandbox build`.

The rest of this guide writes `sandbox` for that command.

## 4. Set up an app

Run this from your project folder (or any folder you choose):

```bash
sandbox init https://app.example.com
```

It does three things:

1. Creates `.sandbox/<app>/` in the current folder, and adds `.sandbox/` to that folder's `.gitignore` (creating
   the file if there is none).
   `<app>` is made from the address, for example `app.example.com`.
2. Opens a Chrome window with a profile used only by this tool.
3. Waits for you to log in and **close the window**. The login is kept for later commands.

Options:

- `--no-login` skips the browser. Use it when the app needs no login, or when a script will log in
  (section 5).
- `--origin <origin...>` adds other addresses the copy should answer for. See below.
- `--app <name>` chooses the name yourself.

### Which addresses the copy answers for

By default the copy answers only for the address you gave. Many apps load scripts, styles or data from other
addresses: a CDN, an API on another subdomain, a login service. In the copy, a request to an address that is
not in scope fails with status `502`.

Add the others when you set up:

```bash
sandbox init https://app.example.com --origin https://api.example.com https://cdn.example.com
```

or later, by editing `origins:` in `.sandbox/<app>/sandbox.config.yaml` and running `sandbox analyze`. An origin
is the scheme, host and port: `https://api.example.com`, with no path.

To find out which ones you need, run the copy (section 6), use the app, and look for `502` entries in the
request log.

### Several apps

Each app gets its own folder under `.sandbox/`. When there is more than one, add `--app <name>` to every
command.

## 5. Record the app

A recording is a **capture**. You can make as many as you like; the copy is built from all of them together.
There are three ways to record.

### A person uses the app

```bash
sandbox capture
```

A Chrome window opens, already logged in. Use the app the way your agent will have to: open the screens, run
the searches, and do each kind of change at least once. **Close the window to finish.**

What to cover, in order of value:

1. Every screen your agent will visit.
2. Several records of the same kind (four or five patients, orders, tickets). The tool learns what an address
   pattern looks like from seeing more than one, and holds some back to test the copy.
3. Each kind of change your agent will make, followed by looking at the result. A read after a write is the
   strongest evidence the copy can have.

### A script uses the app

```bash
sandbox capture --script my-session.mjs --headless
```

The file is an ES module whose default export receives a [Playwright](https://playwright.dev) page that is
already open at the app's start address:

```js
export default async function session(page, { context }) {
  // Log in only when the saved session is not valid any more.
  if (await page.locator("input[name=password]").count()) {
    await page.fill("input[name=user]", "test-user");
    await page.fill("input[name=password]", process.env.APP_TEST_PASSWORD);
    await page.click("button[type=submit]");
  }
  await page.goto(new URL("/orders/1001", page.url()).href);
  await page.waitForSelector("h1");
}
```

Use this when no person is available (an agent is running the tool, or in CI) and for sessions you want to
repeat exactly. Wait for the page to finish loading after each step, as the example does; a request that has
not finished when the script ends may be recorded without its response. A working example is
[`fixtures/tiny-clinic/session.mjs`](../fixtures/tiny-clinic/session.mjs). If the script throws, nothing is
saved.

### The tool explores by itself

```bash
sandbox capture --explore --headless --max-actions 100
```

The tool clicks through the app with no model, using the saved login. It is built to be safe on a real system:

- It does not press controls that look like they commit something (save, submit, delete, send, sign, pay).
- Requests other than plain reads are blocked before they leave the browser, unless `sandbox policy` marks
  them as reads. Unknown requests are blocked.

So exploring widens the coverage of screens and reads, and records no writes. It does not fill in forms. Run a
person's or a script's session first, so the login is valid and the policy has something to work from.

`--allow-writes` removes the second protection. Use it only on a system you own that can be reset.

### Reads that look like writes

Some apps send a search or a filter as a `POST`. The tool blocks those while exploring, because it cannot tell
them from a change. List its decisions and correct them:

```bash
sandbox policy
sandbox policy --set "POST app.example.com /api/search=read"
```

The key is the method, the host and the path pattern exactly as `sandbox policy` prints them. Decisions are
`read`, `write` or `unknown`. A decision you set is never overwritten.

### After every capture

The tool removes secrets from the capture (section 10) and regroups all captures into endpoints. `sandbox
analyze` prints the summary again at any time:

```
Endpoints: 15  (static 2, read 8, write 3, session 1, noise 1)
Exchanges: 55; kept back for checking: 10; read-after-write checks: 3
Named in the app's code but never seen (3): /notes, /sign, /ws
```

| Kind | Meaning | In the copy |
|---|---|---|
| static | The same bytes every time (scripts, styles, images) | The stored file |
| read | Depends on stored data | A handler, or the latest recording of the same request |
| write | Changes stored data | A handler, or the recording (then nothing changes) |
| session | Login, logout, keep-alive | The recorded success, whatever is typed |
| noise | Analytics and telemetry | An empty `204` |

"Named in the app's code but never seen" lists addresses found in the app's JavaScript that no capture used. It
is a hint about what you have not recorded yet.

## 6. Run the copy and attach an agent

```bash
sandbox up
```

```
The copy of app.example.com is running.
  App URL (unchanged):  https://app.example.com/
  Attach your agent to: http://127.0.0.1:9333   (Chrome DevTools address)
  Control:              POST http://127.0.0.1:8878/reset   GET http://127.0.0.1:8878/state | /log | /ledger
Press Ctrl-C to stop.
```

The command keeps running. It starts three things:

- **The copy**, behind a local proxy on port 8877.
- **A Chrome window** that sends every request to that proxy. Inside this Chrome, the app's real address shows
  the copy. Nothing reaches the real app. Other browsers on your machine are not affected.
- **A control address** on port 8878.

Stop it with Ctrl-C, or from another terminal with `sandbox down`. Only one copy runs at a time.

### Attach your agent

Your agent must drive the Chrome that `sandbox up` started; that is the only browser that sees the copy. Most
browser automation tools can attach to a running Chrome when given its DevTools address. The agent then uses
the app's real addresses and needs no other change.

Playwright:

```js
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages()[0];
await page.goto("https://app.example.com/");
```

Puppeteer:

```js
import puppeteer from "puppeteer";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333" });
```

For other frameworks, look for an option named something like "connect to an existing browser" or "CDP URL" and
give it `http://127.0.0.1:9333`.

In the copy nobody needs to log in: the login request is answered with the recorded success whatever is typed,
and pages behind the login are served directly.

### Use your own browser

`sandbox up --no-chrome` starts the copy without Chrome and prints the flags a Chromium-based browser needs:

```
Start Chrome with:    --proxy-server=127.0.0.1:8877 --proxy-bypass-list=<-loopback> --ignore-certificate-errors-spki-list=... --user-data-dir=<empty dir>
```

Start your browser with those flags and a new, empty profile folder. The certificate flag makes that one
browser accept the copy's certificate for HTTPS addresses; nothing is installed on your system.

### The control address

| Request | What it does |
|---|---|
| `GET /health` | `{ "ok": true, "app": ..., "clusters": ... }` |
| `POST /reset` | Puts the copy's data back to the start. Same as `sandbox reset` |
| `GET /state` | The copy's database as JSON, one key per table. Use it in test assertions |
| `GET /log` | Every request made to the copy, in order |
| `GET /ledger` | The trust labels (section 8) |

Each `/log` entry has `method`, `url`, `status` and `served`:

| `served` | Meaning |
|---|---|
| `static` | A stored file |
| `replay` | A recording, repeated |
| `generated` | A handler answered from the database |
| `stub` | Login and similar: the recorded success |
| `noise` | Analytics, answered with nothing |
| `uncaptured` | Nothing recorded for this request. Status `501` |

After an agent run, filter the log for `uncaptured`. Those are the places where your agent went beyond what the
copy knows, and what to record next.

### Options

- `--headless` runs Chrome without a window.
- `--port`, `--control-port`, `--cdp-port` change the three ports (defaults 8877, 8878, 9333).
- `--replay-only` ignores the handlers and answers only from recordings.
- `--today` makes the copy's clock the real clock. By default the clock continues from the end of the last
  capture, so dates in the copy stay consistent with the recorded data.

## 7. Make the copy keep state

A replay copy cannot show the result of a write. A stateful copy can: it has a SQLite database and one handler
file per endpoint.

```bash
sandbox build --max-usd 20
```

A coding agent (Claude, through the Claude Agent SDK) reads the recordings and writes the database schema, the
starting data and the handlers. The tool then checks the result and sends failures back for repair, until
everything passes, the repair limit is reached, or the money runs out.

It needs an Anthropic API key, in the environment or in a file named `.env` in the folder you run the command
from:

```
ANTHROPIC_API_KEY=sk-ant-...
```

What it prints:

```
11 endpoints to build. Rough cost $5-18; hard stop at $20. Uses your ANTHROPIC_API_KEY.
Start? [y/N]
  model: started (attempt 1)
  model: finished, $0.26
  implement:c_0001: started (attempt 1)
  ...
Build finished. Spent about $1.08 (the SDK's estimate, not a bill).
Endpoints: 8 verified, 6 replayed-only, 0 inferred, 0 uncaptured, 1 external
```

- The rough cost is a wide guess. `--max-usd` is the real limit; without it the limit is `budgets.buildUsd` in
  the config file (40 by default). The amount printed at the end is an estimate, not your bill.
- `--yes` skips the question. The question is also skipped when the command is not run from a terminal.
- `--resume` continues a build that was interrupted or ran out of money, without repeating finished steps.
- `--cluster c_0003,c_0007` builds only those endpoints. The ids are in `sandbox report`.

The only measured build so far is the test app: 11 endpoints, about $1.10 and three minutes. A large app will
cost more and may not finish cleanly; start with a low `--max-usd`.

### Fix the copy by hand

Everything the build writes is a plain file under `.sandbox/<app>/replica/`: `schema.sql`, `seed.sql`, one
TypeScript file per endpoint in `routes/`, shared pieces in `templates/`. When a handler is wrong for your app,
edit it and check it:

```bash
sandbox verify
```

The rules a handler follows are in [CONTRACT.md](CONTRACT.md). A complete hand-written example is in
[`fixtures/tiny-clinic/replica/`](../fixtures/tiny-clinic/replica).

## 8. Know what to trust

```bash
sandbox verify
```

```
20/20 checks pass. Endpoints: 7 verified, 7 replayed-only, 0 inferred, 0 uncaptured, 1 external
```

`verify` replays every recorded session against the copy, in order, from the starting data, and compares each
answer with what the real app sent. It uses no model. Parts of a response that change by themselves
(timestamps, tokens, request ids) are ignored. It exits with code 1 when a check fails, and prints each failure
with the first difference. On a replay copy it has nothing to check and prints `0/0 checks pass`.

There are three levels of check:

| Level | Question |
|---|---|
| L1 | Does the handler reproduce the recordings the builder was shown? |
| L2 | Does it answer correctly for a record the builder was never shown? |
| L3 | After a recorded write, do the recorded reads that followed still match? |

and each endpoint gets one label:

| Label | Meaning | Trust it for |
|---|---|---|
| verified | Passed L2 or L3 | Records and sequences beyond the ones recorded |
| replayed-only | Reproduces the recordings only | Exactly what was recorded |
| inferred | A handler exists but a check fails | Nothing yet |
| uncaptured | Never recorded | Nothing; it answers `501` |
| external | Analytics and the like | Nothing; it is ignored |

`sandbox report` prints the full table: every endpoint with its label and check counts, and every recorded
action (each click and form submit) with the label of the weakest endpoint it depends on. The same data is in
`.sandbox/<app>/replica/ledger.json` and at `GET /ledger`.

To raise a label from replayed-only to verified, record more: another record of the same kind, or a read after
the write. Then run `sandbox build --resume`.

## 9. Keep up with the real app

Real apps change. The drift check tells you when the copy has fallen behind.

```bash
sandbox drift
```

It opens the real app with the saved login, visits the recorded screens, repeats the recorded reads, and
compares the structure with the recordings: fields in API responses, form fields, and buttons and links on each
screen. It only reads. It prints a report and saves it to `.sandbox/<app>/drift/drift-report.md`.

| Exit code | Meaning |
|---|---|
| 0 | No drift |
| 1 | Behavioural or cosmetic changes only (something was added, or page markup changed) |
| 2 | Breaking changes (something your agent may rely on was removed or renamed) |
| 3 | The login has expired. Run `sandbox login`, then try again |

Changes in data alone (a new patient, a different total) are not drift.

- `sandbox drift --update` takes the new recording into the copy. If the copy is stateful, it rebuilds the
  affected endpoints with the model; cap that with `--max-usd`.
- `sandbox schedule daily --hour 6` writes a scheduled job that runs the check every morning and prints the
  command that turns it on (a launchd file on macOS, a cron line on Linux).
- `sandbox login` opens the browser so a person can log in again.

## 10. Secrets and personal data

**Secrets.** Before anything else reads a capture, session cookies, tokens, CSRF values and typed passwords are
replaced with placeholders such as `SBX_SESSION_1`. The analysis, the builder and the copy only ever see that
version. The untouched recording stays in `.sandbox/<app>/captures/<id>/` on your machine, with the Chrome
profile and the saved cookies. Treat that folder like a password and never commit it.

**Personal data.** By default the tool removes secrets only. If the app shows real people's data:

```bash
sandbox scrub --pii       # replace personal data with consistent fake values
sandbox scrub --review    # show what was replaced and what still looks personal
sandbox scrub --confirm   # say you have reviewed it; needed before `sandbox build` will run
```

Replacement works on labelled fields (a JSON key or form field called `name`, `dob`, `phone`, and so on) and on
patterns (emails, phone numbers, dates). **A name that appears only inside free text is missed.** `--review`
lists text that still looks like a name or a date so you can check. This is help, not a guarantee: decide for
yourself whether the result may be sent to a model.

`sandbox scrub --off` goes back to secrets only, for apps whose data is fictional.

## 11. Command reference

Every command accepts `--app <name>`, needed only when `.sandbox/` holds more than one app.

| Command | What it does | Needs |
|---|---|---|
| `sandbox doctor` | Checks the machine | |
| `sandbox init <url>` | Creates `.sandbox/<app>/` and opens Chrome for a login. `--no-login`, `--origin <origin...>` | A person, unless `--no-login` |
| `sandbox login` | Opens Chrome with the saved profile to log in again | A person |
| `sandbox capture` | Records a person's session until the window is closed. `--screenshots`, `--label <text>` | A person |
| `sandbox capture --script <file>` | Records a scripted session. `--headless` | |
| `sandbox capture --explore` | Records an automatic read-only crawl. `--max-actions <n>` (default 300), `--headless`, `--allow-writes` | A valid login |
| `sandbox policy` | Lists read/write decisions. `--set "<key>=<read\|write\|unknown>"` | |
| `sandbox scrub` | Re-runs secret removal. `--pii`, `--off`, `--review`, `--confirm` | |
| `sandbox analyze` | Regroups all captures into endpoints and prints the summary | |
| `sandbox build` | Has a model write the stateful copy, then checks it. `--max-usd <x>`, `--yes`, `--resume`, `--cluster <ids>` | API key |
| `sandbox verify` | Checks the copy against the recordings. `--json`, `--cluster <ids>`, `--no-write`. Exit 1 on failure | |
| `sandbox report` | Prints the labels per endpoint and per action as Markdown; also saved as `replica/report.md` | |
| `sandbox up` | Runs the copy and a Chrome attached to it. `--headless`, `--no-chrome`, `--replay-only`, `--today`, `--port`, `--control-port`, `--cdp-port` | |
| `sandbox reset` | Puts the running copy's data back to the start | A running copy |
| `sandbox down` | Stops the running copy | A running copy |
| `sandbox drift` | Compares the real app with the recordings. `--headless`, `--update`, `--max-usd <x>`. Exit 0, 1, 2 or 3 | A valid login |
| `sandbox schedule daily` | Writes a daily drift job. `--hour <h>` | |

Errors are printed as `sandbox: <message>` and the command exits with code 1.

## 12. Files

Everything for an app is under `.sandbox/<app>/`. The parts you may want to read or edit:

| Path | What it is |
|---|---|
| `sandbox.config.yaml` | Start address, origins in scope, scrub mode, model names, budgets |
| `policy.yaml` | Read or write decision per request kind |
| `captures/<id>/` | One recording: events, bodies, page snapshots, a HAR file, and the scrubbed version |
| `analysis/` | Endpoints, what changes by itself, the held-back set, an OpenAPI file for the JSON endpoints |
| `replica/` | The stateful copy: `schema.sql`, `seed.sql`, `routes/`, `templates/`, `ledger.json`, `report.md` |
| `drift/` | The latest drift report |
| `profile/`, `session-cookies.json`, `ca/` | The saved login and the copy's certificate. Private |

The complete list with formats is in [FORMATS.md](FORMATS.md).

To start an app again from nothing, delete `.sandbox/<app>/`. To remove one recording, delete its folder under
`captures/` and run `sandbox analyze`.

## 13. Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| A page in the copy is blank or half-loaded | A script or data file comes from an address that is not in scope | Look for `502` in `GET /log`, add those origins (section 4), run `sandbox analyze`, restart the copy |
| `501` with `X-Sandbox: uncaptured` | That request was never recorded with those parameters | Record a session that makes it, then restart the copy |
| The copy shows a record but not the one your agent asked for | Replay copies only know recorded records | Record that record, or build the stateful copy |
| A write "works" but nothing changes | It is a replay copy, or that endpoint is replayed-only | Build the stateful copy; record a read after the write |
| `The app's session has expired` | The app logged the tool out | `sandbox login`, or re-run a `--script` capture that logs in |
| `capture --explore` reports `Explored 1 states with 0 actions` | It landed on the login page | The same: log in again |
| `Capture <id> has not been scrubbed` | A capture folder is incomplete | `sandbox scrub`; if it persists, delete that folder under `captures/` |
| `Capture <id> holds personal data and has not been reviewed` | `scrub --pii` was used | `sandbox scrub --review`, then `sandbox scrub --confirm` |
| `ANTHROPIC_API_KEY is not set` | `sandbox build` has no key | Put it in `.env` in the folder you run from, or export it |
| `The copy is not running` | `reset` or `down` without `up` | `sandbox up` |
| An "address already in use" error from `sandbox up` | A copy is already running, or the port is taken | `sandbox down`, or choose other ports |
| Chrome does not open | Chrome is not installed where the tool looks | Install Chrome, or `pnpm --filter thousand-sandbox exec playwright install chromium` |
| Live updates do not arrive in the copy | WebSockets are recorded but not replayed | Nothing yet; see Limits |
| `verify` reports failures after you edited a handler | The handler's answer differs from the recording | Read the printed difference; it shows the first place they diverge |
| `sandbox verify` prints `0/0 checks pass` | There is no stateful copy yet | Normal for a replay copy |

When something else goes wrong, the most useful things to send with a report are the command, its full output,
`sandbox report`, and the `uncaptured` and `502` lines from `GET /log`. Do not send the `captures/` folder: it
holds the unscrubbed recording.

## 14. Limits

The full list is in [STATUS.md](STATUS.md). The ones you are most likely to meet:

- **Not yet run on a large real app.** Apps built from frames, pop-up windows and pages assembled on the server
  are the likely trouble spots.
- **Chromium-based browsers only.**
- **WebSockets and server-sent events are not replayed.** The copy refuses those connections.
- **Service workers are switched off** while recording.
- **Exploring does not fill in forms**, so writes are learned only from a person's or a script's session.
- **Requests the app never made are not guessed.** An endpoint nobody recorded answers `501`.
- **One copy at a time** per machine with the default ports.
- **Personal-data removal is partial** (section 10).
- **The builder is restricted, not sealed.** It can only write inside the copy's folder and cannot read the
  held-back recordings, but it does not run in a container.
