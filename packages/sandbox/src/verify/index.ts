import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ex } from "../analyze/index.js";
import { loadAnalysis } from "../analyze/index.js";
import { firstDiff, normalizeBody } from "../analyze/normalize.js";
import { Replica } from "../runtime/replica.js";
import type { AppConfig, Ledger, LedgerEntry, LedgerLabel } from "../types.js";
import { type AppPaths, contentType, header, isTextType, sha256, writeJson } from "../util.js";

/** Hash of everything the builder can change. A change during verification fails the run. */
export function replicaHash(paths: AppPaths): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (!["ledger.json", "replica.json", "seed.db"].includes(f))
        parts.push(`${p.slice(paths.replica.length)}:${sha256(readFileSync(p))}`);
    }
  };
  walk(paths.replica);
  return sha256(parts.join("\n")).slice(0, 16);
}

const RANK: Record<LedgerLabel, number> = { uncaptured: 0, inferred: 1, external: 2, "replayed-only": 3, verified: 4 };

export interface VerifyResult {
  ledger: Ledger;
  failures: LedgerEntry["failures"];
  checked: number;
  passed: number;
}

/**
 * Deterministic check of the copy against the recordings. No model is involved.
 *   L1: the copy reproduces the exchanges the builder saw.
 *   L2: it answers a different instance of the same endpoint that the builder never saw.
 *   L3: after a recorded write, the recorded reads that followed still match (the state really changed).
 * Captures are replayed in the order they were recorded, as one timeline starting from seed.db. A capture
 * marked afterReset (the app's data was put back before it) starts again from the seed.
 */
let runs = 0;

export async function verify(
  paths: AppPaths,
  config: AppConfig,
  opts: { write?: boolean; onlyClusters?: string[]; buildOnly?: boolean } = {},
): Promise<VerifyResult> {
  const before = replicaHash(paths);
  const { clusters, volatile, split, corpus } = loadAnalysis(paths, config);
  const replica = new Replica(paths, config, { replaySet: "build", copy: `verify-${process.pid}-${++runs}` });
  await replica.load();

  const heldOut = new Set(split.heldOut);
  const l3Reads = new Set(split.l3.flatMap((p) => p.reads));
  const entries = new Map<string, LedgerEntry>();
  for (const c of clusters) {
    const generated = replica.hasRoute(c.id);
    let label: LedgerLabel = "replayed-only";
    let served: LedgerEntry["served"] = "replay";
    if (c.class === "static") {
      label = "verified";
      served = "static";
    } else if (c.class === "noise") {
      label = "external";
      served = "stub";
    } else if (c.class === "session") served = "stub";
    if (generated) served = "generated";
    entries.set(c.id, {
      cluster: c.id,
      key: c.key,
      class: c.class,
      label,
      served,
      checks: { l1: [0, 0], l2: [0, 0], l3: [0, 0] },
      evidence: [],
      failures: [],
    });
  }

  const timeline = corpus.exchanges
    .filter((x) => x.cluster && ["read", "write", "session"].includes(entries.get(x.cluster)?.class ?? ""))
    .sort((a, b) =>
      a.capture === b.capture
        ? a.episode === b.episode
          ? a.ts - b.ts
          : a.episode.localeCompare(b.episode)
        : a.capture.localeCompare(b.capture),
    );

  let checked = 0;
  let passed = 0;
  let inCapture = "";
  for (const x of timeline) {
    if (x.capture !== inCapture) {
      if (inCapture && corpus.afterReset.has(x.capture)) replica.reset();
      inCapture = x.capture;
    }
    const entry = entries.get(x.cluster!)!;
    const headers: Record<string, string> = {};
    for (const [k, v] of x.reqHeaders)
      if (!/^(content-length|host|connection|accept-encoding)$/i.test(k) && !k.startsWith(":"))
        headers[k.toLowerCase()] = v;
    const res = await replica.handle({
      method: x.method,
      url: x.url,
      headers,
      body: x.reqBody ? x.bodies.get(x.reqBody) : Buffer.alloc(0),
    });
    if (!replica.hasRoute(x.cluster!)) continue; // replayed clusters are labelled, not checked
    if (opts.onlyClusters && !opts.onlyClusters.includes(x.cluster!)) continue;
    const level = l3Reads.has(x.id) ? "l3" : heldOut.has(x.id) ? "l2" : "l1";
    if (x.status === 200 && !x.resBody) continue; // the recorder could not read this body, so there is nothing to compare
    const own = volatile[x.cluster!];
    const shared = volatile["*"];
    const diff = compare(x, res, {
      jsonPaths: own?.jsonPaths ?? [],
      textContexts: [...(own?.textContexts ?? []), ...(shared?.textContexts ?? [])],
      headers: [],
    });
    checked++;
    entry.checks[level][1]++;
    if (!diff) {
      passed++;
      entry.checks[level][0]++;
      if (level !== "l1" && entry.evidence.length < 5) entry.evidence.push(x.id);
    } else if (entry.failures.length < 10)
      // In build-only mode (what the builder sees) a held-back exchange shows that it failed, not what was expected.
      entry.failures.push({
        level,
        exchange: opts.buildOnly && level !== "l1" ? "held back" : x.id,
        diff: opts.buildOnly && level !== "l1" ? (diff.startsWith("status") ? diff : "body differs") : diff,
      });
  }
  replica.close(true);

  for (const e of entries.values()) {
    if (e.served !== "generated") continue;
    const fail = e.failures.length > 0;
    const strong = e.checks.l2[0] + e.checks.l3[0] > 0;
    e.label = fail ? "inferred" : strong ? "verified" : "replayed-only";
  }
  // Endpoints the builder wrote without ever seeing them answered.
  const inferredFile = join(paths.replica, "inferred.json");
  if (existsSync(inferredFile))
    for (const c of JSON.parse(readFileSync(inferredFile, "utf8")) as { id: string; key: string }[])
      entries.set(c.id, {
        cluster: c.id,
        key: c.key,
        class: "write",
        label: "inferred",
        served: "generated",
        checks: { l1: [0, 0], l2: [0, 0], l3: [0, 0] },
        evidence: [],
        failures: [],
      });

  const byAction = new Map<string, Set<string>>();
  for (const x of corpus.exchanges) {
    if (!x.causedBy || !x.cluster) continue;
    const cls = entries.get(x.cluster)?.class;
    if (cls === "static" || cls === "noise") continue;
    if (!byAction.has(x.causedBy)) byAction.set(x.causedBy, new Set());
    byAction.get(x.causedBy)!.add(x.cluster);
  }
  const actions: Ledger["actions"] = [];
  for (const a of corpus.actions) {
    const cs = [...(byAction.get(a.id) ?? [])];
    if (!cs.length) continue;
    const label = cs.map((c) => entries.get(c)!.label).sort((p, q) => RANK[p] - RANK[q])[0]!;
    actions.push({ action: a.id, name: `${a.kind} ${a.target?.name ?? ""}`.trim().slice(0, 80), label, clusters: cs });
  }

  const summary: Record<LedgerLabel, number> = {
    verified: 0,
    "replayed-only": 0,
    inferred: 0,
    uncaptured: 0,
    external: 0,
  };
  for (const e of entries.values()) summary[e.label]++;
  const ledger: Ledger = {
    builtAt: new Date().toISOString(),
    replicaHash: before,
    clusters: [...entries.values()],
    actions,
    summary,
  };

  if (replicaHash(paths) !== before)
    throw new Error("The replica changed while it was being verified. Result discarded.");
  if (opts.write !== false) writeJson(join(paths.replica, "ledger.json"), ledger);
  return { ledger, failures: ledger.clusters.flatMap((c) => c.failures), checked, passed };
}

function compare(
  x: Ex,
  res: { status: number; headers: [string, string][]; body: Buffer },
  rules?: { jsonPaths: string[]; textContexts: string[]; headers: string[] },
): string {
  const wantStatus = x.status === 304 ? 200 : x.status;
  if (res.status !== wantStatus) return `status: expected ${wantStatus}, got ${res.status}`;
  if (x.status >= 300 && x.status < 400) {
    const want = header(x.resHeaders, "location") ?? "";
    const got = header(res.headers, "location") ?? "";
    return want === got ? "" : `location: expected ${want}, got ${got}`;
  }
  const ct = contentType(x.resHeaders);
  const want = x.resBody ? x.bodies.get(x.resBody) : Buffer.alloc(0);
  if (!isTextType(ct)) return sha256(want) === sha256(res.body) ? "" : "body bytes differ";
  const a = normalizeBody(ct, want.toString("utf8"), rules);
  const b = normalizeBody(ct, res.body.toString("utf8"), rules);
  return a === b ? "" : firstDiff(a, b);
}

/** Ledger and coverage as Markdown. */
export function reportMarkdown(ledger: Ledger, coverage?: Record<string, number>): string {
  const lines = ["# Sandbox report", "", `Built ${ledger.builtAt}. Replica ${ledger.replicaHash}.`, ""];
  if (coverage)
    lines.push(
      `Recorded ${coverage.exchanges} exchanges in ${coverage.clusters} endpoints; ${coverage.unobservedInCode ?? 0} endpoints appear in the app's code but were never seen.`,
      "",
    );
  lines.push("| Label | Endpoints |", "|---|---|");
  for (const [k, v] of Object.entries(ledger.summary)) lines.push(`| ${k} | ${v} |`);
  lines.push(
    "",
    "## Endpoints that change or read data",
    "",
    "| Endpoint | Class | Served by | Label | L1 | L2 | L3 |",
    "|---|---|---|---|---|---|---|",
  );
  for (const c of ledger.clusters) {
    if (c.class !== "read" && c.class !== "write" && c.class !== "session") continue;
    const f = (p: [number, number]) => (p[1] ? `${p[0]}/${p[1]}` : "");
    lines.push(
      `| \`${c.key}\` | ${c.class} | ${c.served} | ${c.label} | ${f(c.checks.l1)} | ${f(c.checks.l2)} | ${f(c.checks.l3)} |`,
    );
  }
  const failed = ledger.clusters.filter((c) => c.failures.length);
  if (failed.length) {
    lines.push("", "## Failures", "");
    for (const c of failed)
      for (const f of c.failures.slice(0, 3))
        lines.push(`- \`${c.key}\` ${f.level.toUpperCase()} ${f.exchange}: ${f.diff}`);
  }
  if (ledger.actions.length) {
    lines.push("", "## Actions", "", "| Action | Label |", "|---|---|");
    for (const a of ledger.actions) lines.push(`| ${a.name.replace(/\|/g, "/")} | ${a.label} |`);
  }
  return `${lines.join("\n")}\n`;
}
