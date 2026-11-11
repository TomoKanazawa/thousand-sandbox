# For AI agents operating this tool

You are an AI agent asked to install, run or test Thousand Sandbox for someone. This page tells you what you
need that the other documents assume a person would work out.

Read in this order: this page, then [docs/TUTORIAL.md](docs/TUTORIAL.md) (run it once, exactly as written,
before touching a real app), then [docs/GUIDE.md](docs/GUIDE.md) for the app you were asked about.
[docs/STATUS.md](docs/STATUS.md) says what is not built; check it before reporting something as a bug.

## What the tool is

It records a web app and runs a local copy of it, so an agent can be tested against the copy instead of the
real app. The command is `bin/sandbox` in this repository. It writes everything into `.sandbox/<app>/` inside
the folder it is run from.

## Running it without a person

Three commands are interactive by default. Use the forms on the right.

| Default | It waits for | Use instead |
|---|---|---|
| `sandbox init <url>` | A person to log in and close a Chrome window | `sandbox init <url> --no-login` |
| `sandbox capture` | A person to use the app and close the window | `sandbox capture --script <file> --headless`, or `--explore --headless` |
| `sandbox build` | A `y` typed at a prompt, when run from a terminal | `sandbox build --yes --max-usd <x>` |

`sandbox login` always needs a person. If the app's login needs a person (a CAPTCHA, a code sent to a phone,
single sign-on), stop and ask the person you are working for to run `sandbox init <url>` or `sandbox login`
themselves. Do not try to get around it.

Two commands do not return until stopped: `sandbox up`, and the test app
`node fixtures/tiny-clinic/server.mjs`. Start them in the background, or in a separate terminal, and stop them
with `sandbox down` and by killing the process. Add `--headless` to `up`, `capture` and `drift` if you have no
display.

Your shell may not keep variables, aliases or the working folder between commands. Use the full path of
`bin/sandbox`, and `cd` into the working folder in the same command line as each call:

```bash
cd /path/to/workdir && /path/to/thousand-sandbox/bin/sandbox analyze
```

## Credentials and money

- Never print, log or paste an API key or a password. `sandbox build` reads `ANTHROPIC_API_KEY` from the
  environment or from `.env` in the working folder. If it is missing, ask the person to put it there; do not
  ask them to paste it into the conversation.
- A capture script that logs in should read the password from an environment variable, as the example in the
  guide does. The test app's password, `test-password`, is not a secret.
- `sandbox build` and `sandbox drift --update` spend money on a model. Always pass `--max-usd`, and tell the
  person the cap before you start unless they already gave you one. Nothing else in the tool costs anything.

## What you must not do

- **Do not record an app the person has not told you to record.** A capture copies an app's pages and data to
  this machine.
- **Do not make changes in a real app** unless you were told which test record to use. `capture --explore` is
  read-only by design; `--allow-writes` and scripted sessions are not.
- **Do not add `--allow-writes` on a system that cannot be reset.**
- **On a test system that was reset since the last capture, record with `--after-reset`**, or `sandbox verify`
  will fail for a reason that is not a fault in the copy.
- **Do not commit or upload anything under `.sandbox/`.** It holds the unscrubbed recording, a browser profile
  with a live login, and session cookies.
- **Do not add anything to this repository that defeats bot detection**, and do not add recordings of other
  companies' software to it.

## How to tell whether something worked

Do not judge by whether a command exited without an error. Check the result:

| Step | Evidence that it worked |
|---|---|
| Capture | The summary line shows more than a handful of exchanges, and `sandbox analyze` lists `read` endpoints. One state and zero actions from `--explore` means it was looking at a login page |
| Copy running | `curl -s http://127.0.0.1:8878/health` returns `"ok": true`. For the first few seconds it does not answer or says `false`; repeat until it is true before attaching |
| Copy is really the copy | Stop or disconnect the real app if you can, then load a recorded page through the attached Chrome. Or check that the request appears in `GET /log` |
| Agent run | `GET /log` has no entries with `served` equal to `uncaptured` or `external` for what the agent needed |
| A write was kept | The row is in `GET /state`, and it is gone again after `sandbox reset` (the request log survives a reset) |
| Stateful copy is right | `sandbox verify` exits 0 and prints `n/n checks pass` with n above zero |
| Exploring changed nothing | Compare the real app's data before and after, if the app lets you read it |
| Drift check | Exit code 0, 1, 2 or 3 as described in the guide |

The copy is only seen by the Chrome that `sandbox up` started. A browser you launch yourself, `curl`, or a
fetch tool goes to the real app, not the copy. Attach to `http://127.0.0.1:9333` over the Chrome DevTools
Protocol.

## Reporting back

When you were asked to test the tool, report in this shape, in plain language:

1. **What you ran:** the app, the commands, and which of them were scripted, explored or done by a person.
2. **What worked**, with the evidence from the table above (the actual lines, not a summary of them).
3. **What failed:** the exact command, its full output, and what you expected. Include the `uncaptured` and
   `external` lines from `GET /log` and the output of `sandbox report`.
4. **What you could not test and why** (needed a person, needed a key, not built yet according to STATUS.md).
5. **Where the documents were wrong or unclear.** Quote the sentence. A step that did not behave as written is
   a finding even if you worked around it.
6. **Cost**, if a model was used: the amount the build printed.

Never include the contents of `.sandbox/<app>/captures/`, cookies or keys in a report.

## Working on the code

```bash
pnpm install
pnpm --filter thousand-sandbox exec playwright install chromium
pnpm build && pnpm test      # 21 tests, about a minute
pnpm lint
```

The source is one package, `packages/sandbox/src`. The handler contract the builder follows is
[docs/CONTRACT.md](docs/CONTRACT.md); file formats are in [docs/FORMATS.md](docs/FORMATS.md). When you change
behaviour, update the tutorial and the guide in the same change: every command and output shown in them was
run as written.
