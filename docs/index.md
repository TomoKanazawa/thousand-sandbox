# Thousand Sandbox documentation

Thousand Sandbox makes an exact working copy of a web app, as a sandbox for testing AI agents.

You point it at a web app you can log in to. It records the app while it is used, then runs a local copy that
serves the app's own pages and scripts at the app's own addresses. Your agent works in the copy: no client
access needed, nothing real gets changed, and a reset takes under a second.

It runs on your machine and sends nothing anywhere. The only outside call is to Anthropic, with your own API
key, and only when you run `sandbox build`.

## Where to start

| If you want to | Read |
|---|---|
| See every part working on a bundled test app, with no account and no API key | [Tutorial](TUTORIAL.md) |
| Use it on an app of your own | [Guide](GUIDE.md) |
| Have an AI agent install, run or test it | [For AI agents](../AGENTS.md) |
| Know what is finished and what is not | [Status](STATUS.md) |

## Install

You need Node 22.13 or newer, pnpm 9 or newer, and Google Chrome.

```bash
git clone https://github.com/TomoKanazawa/thousand-sandbox.git
cd thousand-sandbox
pnpm install
pnpm build
```

The command is `bin/sandbox` in the clone. The [Tutorial](TUTORIAL.md) continues from here.

## Status

Early. Everything in the tutorial works on the test app and passes its tests. It has not yet been run on a
large real app. [Status](STATUS.md) lists what is built and what is missing.

The code is open source under Apache-2.0, at
[github.com/TomoKanazawa/thousand-sandbox](https://github.com/TomoKanazawa/thousand-sandbox).
