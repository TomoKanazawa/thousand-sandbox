# Tutorial: the whole tool in 15 minutes

This walks through every part of Thousand Sandbox on a small test app that ships in this repository. It needs
no account, no outside website and no person at the keyboard. Only step 9 uses a model and costs money (about
$1); you can skip it.

Every command below was run as written, and the output shown is what it printed. Paths, dates and capture ids
will differ on your machine, and the counts of exchanges and checks can differ by a few from run to run.

**What you will have at the end:** a working copy of the test app that keeps running after the real app is
switched off, a browser that any agent can attach to, and a report of which actions in the copy are proven.

## 0. Install

You need Node 22.13 or newer, pnpm 9 or newer, and Google Chrome. Tested on macOS; Linux should work; Windows is
untested.

```bash
git clone https://github.com/TomoKanazawa/thousand-sandbox.git
cd thousand-sandbox
pnpm install
pnpm build
```

The command is `bin/sandbox` inside the clone. To keep the rest of this page short, store its full path in a
variable. Replace the path with yours:

```bash
REPO=/absolute/path/to/thousand-sandbox
SB=$REPO/bin/sandbox
```

If your shell does not keep variables between commands (many agent tools do not), write the full path each
time instead of `$SB` and `$REPO`.

Check the machine:

```bash
$SB doctor
```

```
ok   Node 22.18.0
ok   Google Chrome
FAIL ANTHROPIC_API_KEY (needed for `sandbox build` only)  -> export ANTHROPIC_API_KEY=...
ok   Claude Agent SDK (needed for `sandbox build` only)
ok   Memory 36 GB
ok   Disk 238 GB free
ok   Docker (optional)
```

A `FAIL` on `ANTHROPIC_API_KEY` is fine until step 9 (it shows `ok` if a key is already set on your machine). If Chrome is missing, install it or run
`pnpm --filter thousand-sandbox exec playwright install chromium`.

## 1. Start the test app

The test app is a small fictional clinic system. Start it and leave it running. It prints one line and keeps
going, so run it in a second terminal or in the background:

```bash
PORT=4010 node $REPO/fixtures/tiny-clinic/server.mjs
```

```
tiny-clinic on http://127.0.0.1:4010  (any user, password "test-password")
```

**Do not restart it during the tutorial.** It keeps logins in memory, so a restart logs the tool out.

## 2. Make a working folder and set up the app

The tool keeps everything for an app in a `.sandbox/` folder inside the folder you run it from. Make an empty
folder and run every later command from it:

```bash
mkdir ~/sandbox-tutorial && cd ~/sandbox-tutorial
$SB init http://127.0.0.1:4010/ --no-login
```

```
Created /Users/you/sandbox-tutorial/.sandbox/127.0.0.1_4010
Next: sandbox capture
```

`--no-login` skips the step where a person logs in by hand in a browser window. The next step logs in from a
script instead. The app's name inside the tool comes from its address: `127.0.0.1_4010`.

## 3. Record a session

A recording is called a capture. This one runs a prepared session: it logs in, opens four patients, adds a
note, deletes it, edits a phone number and runs a search.

```bash
$SB capture --script $REPO/fixtures/tiny-clinic/session.mjs --headless
```

```
Probe pass: 16 of 16 safe GETs repeated.
Capture 20261111-200618 saved. 55 exchanges in 15 endpoints so far.
Next: sandbox up (replay as recorded), or sandbox build (make it stateful).
```

An **exchange** is one request and its response. An **endpoint** is a group of requests of the same kind, for
example every `GET /patients/{id}`. The probe pass repeats each harmless read once more, so the tool can tell
which parts of a response change by themselves (timestamps, tokens).

## 4. Look at what it learned

```bash
$SB analyze
```

```
Endpoints: 15  (static 2, read 8, write 3, session 1, noise 1)
Exchanges: 55; kept back for checking: 10; read-after-write checks: 3
Named in the app's code but never seen (3): /notes, /sign, /ws
Files: /Users/you/sandbox-tutorial/.sandbox/127.0.0.1_4010/analysis
```

- **static, read, write, session, noise** are the kinds of endpoint. The copy treats each kind differently.
- **Kept back for checking** are recordings the builder in step 9 is never shown. They are the test.
- **Named in the code but never seen** are addresses found in the app's JavaScript that the session never used.
  `/sign` is the dangerous "Sign and send chart" button, which the session did not press.

```bash
$SB policy
```

```
write    heuristic  DELETE 127.0.0.1:4010 /api/notes/{id}  (DELETE)
unknown  default    POST 127.0.0.1:4010 /api/patients/{id}/notes
read     heuristic  POST 127.0.0.1:4010 /api/search  (path ends in search)
unknown  default    POST 127.0.0.1:4010 /beacon
unknown  default    POST 127.0.0.1:4010 /login
unknown  default    POST 127.0.0.1:4010 /patients/{id}/edit
```

(It also prints the path of the file that holds these decisions.) This is the list of requests that might change
data, with the tool's decision for each. It decides what the
automatic crawl in step 7 is allowed to send: `read` passes, `write` and `unknown` are blocked.

## 5. Run the copy, with the real app switched off

Stop the test app now (Ctrl-C in its terminal, or `pkill -f tiny-clinic/server.mjs`). This proves that what
follows comes from the copy.

Start the copy. It also keeps running, so use a second terminal or the background:

```bash
$SB up --headless
```

```
The copy of 127.0.0.1_4010 is running.
  App URL (unchanged):  http://127.0.0.1:4010/
  Attach your agent to: http://127.0.0.1:9333   (Chrome DevTools address)
  Control:              POST http://127.0.0.1:8878/reset   GET http://127.0.0.1:8878/state | /log | /ledger
Press Ctrl-C to stop.
```

The tool started a Chrome that sends every request for the app to the copy. The app's address has not changed.
Leave out `--headless` to see the window.

Starting takes a few seconds. The copy is ready when this shows `"ok": true`; a script should repeat it until
it does:

```bash
curl -s http://127.0.0.1:8878/health
```

```
{
  "ok": true,
  "app": "127.0.0.1_4010",
  "endpoints": 15
}
```

## 6. Attach an agent

Any tool that can attach to a running Chrome uses the copy with no code change. The repository has a short
Playwright example, [`packages/sandbox/examples/attach.mjs`](../packages/sandbox/examples/attach.mjs). Its core is
three lines:

```js
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages()[0];
await page.goto("http://127.0.0.1:4010/patients/102");
```

Run it:

```bash
node $REPO/packages/sandbox/examples/attach.mjs
```

```
title: Okafor, Ben - Tiny Clinic | notes: 1
a page that was never recorded: 501 uncaptured
```

The first line is a real page of the app, served by the copy while the app is off. The second shows the rule
the copy follows: **it never makes an answer up.** A request it has no recording for gets status `501` and the
header `X-Sandbox: uncaptured`.

See what your agent did:

```bash
curl -s http://127.0.0.1:8878/log
```

Each entry has the method, the URL, the status and `served`: `static`, `replay`, `generated`, `stub`, `noise`,
`uncaptured`, or `external` (an address outside the app, refused with `502`). The entry for `/patients/999` is
the `uncaptured` one. Stop the copy when you are done:

```bash
$SB down
```

```
Stopped.
```

So far this is a **replay copy**: it repeats what was recorded. Writes are answered as they were recorded and
change nothing. Steps 8 and 9 make it keep state.

## 7. Let the tool explore by itself, safely

Start the test app again (step 1) and leave it running for the rest of the tutorial. The restart did two things:
it logged the tool out, and it put the app's data back to where it started. So run the session from step 3
again, and tell the tool about the second point with `--after-reset`:

```bash
$SB capture --script $REPO/fixtures/tiny-clinic/session.mjs --headless --after-reset
```

Without `--after-reset` the tool assumes each recording continues from where the last one ended, as it does on
a real system, and the check in step 8 would fail.

The test app has three addresses for testing the tool: `/__test/state` shows its real data, `/__test/reset`
puts the data back, and `/__test/variant/v2` releases a changed version (used in step 10). Take a fingerprint of
the data:

```bash
curl -s http://127.0.0.1:4010/__test/state | shasum
```

Now let the tool crawl the app by itself:

```bash
$SB capture --explore --headless --max-actions 25
```

```
Explored 7 states with 24 actions; refused 7 controls.
Probe pass: 26 of 26 safe GETs repeated.
Capture 20261111-202147 saved. 280 exchanges in 15 endpoints so far.
Next: sandbox up (replay as recorded), or sandbox build (make it stateful).
```

**Refused 7 controls** are buttons it would not press, such as "Save changes", "Delete" and "Sign and send
chart". Take the fingerprint again:

```bash
curl -s http://127.0.0.1:4010/__test/state | shasum
```

The two fingerprints are the same: the crawl changed nothing in the real app.

## 8. A copy that keeps state, without a model

A **stateful copy** has a small database and one handler per endpoint, so a write changes data and later reads
show it. Step 9 has a model write these files. To see the result without paying for a model, copy in a set
written by hand for this test app:

```bash
mkdir -p .sandbox/127.0.0.1_4010/replica
cp -R $REPO/fixtures/tiny-clinic/replica/. .sandbox/127.0.0.1_4010/replica/
$SB verify
```

```
95/95 checks pass. Endpoints: 7 verified, 7 replayed-only, 0 inferred, 0 uncaptured, 1 external
```

`verify` replays the recorded sessions against the copy and compares every answer. No model is involved. It
exits with code 0 when every check passes. The number of checks depends on how many captures you have made.

Run it and write something. The test app can stay running; the copy's Chrome never reaches it. Start the copy
(`$SB up --headless`, second terminal), wait for `/health` as in step 5, then run the second
example, which adds a note to a patient through the browser:

```bash
node $REPO/packages/sandbox/examples/write-note.mjs
```

```
notes before 1 after 2
```

The copy's database is readable, which is
how you check what an agent really did:

```bash
curl -s http://127.0.0.1:8878/state
```

The `note` table now has one more row. Put the copy back to its starting data:

```bash
$SB reset
```

```
Reset.
```

`/state` shows the original rows again. Stop the copy with `$SB down`.

## 9. Have a model build the stateful copy (optional, about $1)

This replaces the hand-written files from step 8 with ones a coding agent writes from the recordings.

Remove the hand-written copy, and give the tool an Anthropic API key in a file named `.env` in the working
folder:

```bash
rm -rf .sandbox/127.0.0.1_4010/replica
printf 'ANTHROPIC_API_KEY=%s\n' "your-key-here" > .env
$SB build --max-usd 5 --yes
```

```
11 endpoints to build. Rough cost $5-18; hard stop at $5. Uses your ANTHROPIC_API_KEY.
  model: started (attempt 1)
  model: finished, $0.26
  implement:c_0001: started (attempt 1)
  ...
  repair cycle 1: 1 endpoints fail
  implement:c_0003: finished, $0.22
Build finished. Spent about $1.08 (the SDK's estimate, not a bill).
Endpoints: 8 verified, 6 replayed-only, 0 inferred, 0 uncaptured, 1 external
```

It takes about three minutes. The rough cost line is a wide guess; `--max-usd` is the real limit. The build
checks its own work with the same `verify` and repairs what fails. Results vary a little from run to run.

Read the result:

```bash
$SB report
```

The report lists every endpoint and every recorded action with a label:

| Label | Meaning |
|---|---|
| verified | It answered correctly on a recording the builder never saw, or a read after a write matched |
| replayed-only | It reproduces the recordings, but nothing proves it works beyond them |
| inferred | A handler exists but a check fails |
| uncaptured | Never recorded; the copy answers `501` |
| external | Analytics and the like; always answered with an empty response |

Then run the copy and repeat step 8's `write-note.mjs` against it.

## 10. Notice when the real app changes

The drift check visits the real app again, read-only, and compares it with the recordings. The test app must be
running and the tool logged in (re-run step 3's command if you restarted it).

With nothing changed:

```bash
$SB drift --headless
```

```
# Drift report: 127.0.0.1_4010

Checked 2026-11-11T20:08:31.186Z. Compared 12 recorded requests with the live app.

No drift found.
```

Now have the test app release a new version, without restarting it:

```bash
curl -s -X POST http://127.0.0.1:4010/__test/variant/v2 > /dev/null
$SB drift --headless
```

```
# Drift report: 127.0.0.1_4010

Checked 2026-11-11T20:09:59.044Z. Compared 12 recorded requests with the live app.

## Breaking (2)

- [api] GET 127.0.0.1:4010 /api/patients/{id}/notes: field removed: [].author
- [ui] /patients/{id}: control gone or renamed: button "Add note"

## Behavioural (2)

- [api] GET 127.0.0.1:4010 /api/patients/{id}/notes: new field: [].created
- [ui] /patients/{id}: new control: button "Create note"
```

The command's exit code says how bad it is: `0` no drift, `1` additions or cosmetic changes only, `2` breaking,
`3` the login has expired.
Put the test app back with `curl -s -X POST http://127.0.0.1:4010/__test/variant/v1`.

## Clean up

```bash
$SB down                      # if a copy is still running
pkill -f tiny-clinic/server.mjs
rm -rf ~/sandbox-tutorial
```

## Next

- Your own app: [GUIDE.md](GUIDE.md).
- What is finished and what is not: [STATUS.md](STATUS.md).
- If you are an AI agent running this tool for someone: [../AGENTS.md](../AGENTS.md).
