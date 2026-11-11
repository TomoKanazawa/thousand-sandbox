# File formats

Everything lives under `.sandbox/<app>/` on your machine. The types are in `packages/sandbox/src/types.ts`.

```
sandbox.config.yaml      start URL, origins in scope, models, budgets
policy.yaml              read or write decision per endpoint; `by: user` entries are never overwritten
pseudonyms.json          real value -> replacement. Never leaves the machine
session-cookies.json     session cookies of the capture profile. Treat like a password
profile/                 Chrome profile used only by this tool
captures/<id>/
  manifest.json          when, how, scrub status
  episodes/1.jsonl       one event per line: action, exchange, ws, snapshot, probe, console, dialog, popup, gate
  bodies/<sha256>        request and response bodies, stored once
  snapshots/             <id>.html and <id>.aria.txt per snapshot
  har/1.har              Playwright's HAR
  scrubbed/              the same, with secrets (and optionally personal data) replaced. Analysis, the builder
                         and the copy read only this
analysis/
  clusters.json          endpoints: method, host, path template, class, counts, exchange ids
  volatile.json          per endpoint: fields that change with no change of data
  flow.json              values from one endpoint's response that appear in another's request
  split.json             build set, held-out set, read-after-write checks
  spec.yaml              OpenAPI for the JSON endpoints
  code-endpoints.json    paths named in the app's JavaScript but never observed
replica/
  schema.sql  seed.sql   the copy's database; seed.db is rebuilt from them
  routes/*.ts            one handler per endpoint (docs/CONTRACT.md)
  templates/*.ts         shared response builders
  ledger.json            label and evidence per endpoint and per action
  replica.json           what it was built from and what the build cost
build/                   builder input (build set only) and state.json for resume
held-out/                ids the builder must not see
drift/                   drift.json, drift-report.md
run/                     the running copy's database and Chrome profile
```

## Request classes

| Class | Meaning | Served by |
|---|---|---|
| static | Same bytes every time | Stored body |
| read | Depends on stored data | Handler, or the latest recording of the same request |
| write | Changes stored data | Handler, or the recording (nothing changes) |
| session | Login, logout, keep-alive | The recorded success, whatever was typed |
| noise | Analytics, telemetry | Empty `204` |
| uncaptured | Never observed | `501`, header `X-Sandbox: uncaptured` |

## Ledger labels

| Label | Rule |
|---|---|
| verified | Passed on evidence the builder did not see: another instance (L2) or a read after a write (L3) |
| replayed-only | Reproduces recordings; no evidence it generalises |
| inferred | A handler exists but a check fails, or it was written without any recording |
| uncaptured | Answers `501` |
| external | Effects outside the app (analytics); always simulated |
