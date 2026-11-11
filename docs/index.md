---
layout: home
title: Thousand Sandbox
hero:
  name: Thousand Sandbox
  text: An exact working copy of any web app.
  tagline: A sandbox for testing AI agents. It records the app, runs a local copy at the app's own addresses, and tells you which actions in the copy are proven.
  actions:
    - theme: brand
      text: Tutorial, 15 minutes
      link: /tutorial
    - theme: alt
      text: Guide for your own app
      link: /guide
    - theme: alt
      text: View on GitHub
      link: https://github.com/TomoKanazawa/thousand-sandbox
---

<div class="vp-doc home-notes">

## What it does

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

## Status

Early. Everything in the tutorial works on the test app and passes its tests. It has not yet been run on a
large real app. [Status](STATUS.md) lists what is built and what is missing.

</div>

<style>
/* Lines up with the hero above it. */
.home-notes { max-width: 1280px; margin: 0 auto; padding: 0 24px 64px; }
@media (min-width: 640px) { .home-notes { padding: 0 48px 64px; } }
@media (min-width: 960px) { .home-notes { padding: 0 64px 96px; } }
.home-notes > * { max-width: 760px; }
.home-notes table { display: table; }
</style>
