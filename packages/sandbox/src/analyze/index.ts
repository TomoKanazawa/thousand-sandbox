import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { guessFromShape } from "../capture/gate.js";
import type {
  ActionEvent,
  AppConfig,
  Cluster,
  ExchangeEvent,
  Policy,
  ProbeEvent,
  RequestClass,
  SnapshotEvent,
  Split,
  VolatileRules,
} from "../types.js";
import {
  type AppPaths,
  type BodyStore,
  contentType,
  ensureDir,
  episodeOf,
  isTextType,
  listCaptures,
  loadBundle,
  readJson,
  writeJson,
} from "../util.js";
import {
  type ParsedRequest,
  instanceKey,
  matchCluster,
  parseRequest,
  requestParams,
  templateRegex,
} from "./cluster.js";
import { type Rules, learn } from "./normalize.js";

const NOISE_HOSTS =
  /(google-analytics|googletagmanager|doubleclick|googlesyndication|sentry\.io|segment\.(io|com)|mixpanel|hotjar|datadoghq|newrelic|nr-data|fullstory|intercom|amplitude|clarity\.ms|facebook\.(net|com)|bugsnag|logrocket|pendo\.io|optimizely|heapanalytics)/i;
const NOISE_PATH = /\/(beacon|collect|telemetry|analytics|rum|pixel|track(ing)?|log(s|ger)?|metrics|ping)(\/|$|\?)/i;
const SESSION_PATH =
  /(^|[/_.-])(login|logout|logoff|signin|signout|sign-in|sign-out|authenticate|auth|sso|session|keepalive|keep-alive|heartbeat)([/_.-]|$)/i;
const ASSET_TYPES = new Set(["script", "stylesheet", "image", "font", "media", "manifest"]);

export interface Ex extends ExchangeEvent {
  capture: string;
  episode: string;
  parsed: ParsedRequest;
  reqText: string;
  inScope: boolean;
  bodies: BodyStore;
  cluster?: string;
  instance?: string;
  /** The recorder could not read this body; the probe's answer to the same request stands in for it. */
  probeAdopted?: boolean;
}

export interface Corpus {
  exchanges: Ex[];
  probes: (ProbeEvent & { bodies: BodyStore })[];
  actions: (ActionEvent & { capture: string })[];
  snapshots: (SnapshotEvent & { capture: string; dir: string })[];
  byId: Map<string, Ex>;
}

/** Read every scrubbed capture of the app. */
export function loadCorpus(paths: AppPaths, config: AppConfig, only?: string[]): Corpus {
  const corpus: Corpus = { exchanges: [], probes: [], actions: [], snapshots: [], byId: new Map() };
  for (const id of only ?? listCaptures(paths)) {
    const b = loadBundle(paths, id, true);
    if (b.manifest.mode === "drift" && !only) continue;
    for (const e of b.events) {
      if (e.type === "exchange") {
        if (e.blocked || e.status === 0) continue;
        let reqText = "";
        const ct = contentType(e.reqHeaders);
        if (e.reqBody && (isTextType(ct) || !ct)) reqText = b.bodies.text(e.reqBody);
        let parsed: ParsedRequest;
        try {
          parsed = parseRequest(e.method, e.url, ct, reqText);
        } catch {
          continue;
        }
        const ex: Ex = {
          ...e,
          capture: id,
          episode: episodeOf(e),
          parsed,
          reqText,
          inScope: config.origins.includes(parsed.origin),
          bodies: b.bodies,
        };
        corpus.exchanges.push(ex);
        corpus.byId.set(ex.id, ex);
      } else if (e.type === "probe") corpus.probes.push({ ...e, bodies: b.bodies });
      else if (e.type === "action") corpus.actions.push({ ...e, capture: id });
      else if (e.type === "snapshot") corpus.snapshots.push({ ...e, capture: id, dir: join(b.dir, "snapshots") });
    }
    for (const p of corpus.probes) {
      const x = corpus.byId.get(p.of);
      if (x && !x.resBody && x.status === 200 && p.status === 200 && p.resBody) {
        x.resBody = p.resBody;
        x.resHeaders = p.resHeaders;
        x.probeAdopted = true;
      }
    }
  }
  return corpus;
}

export interface Analysis {
  clusters: Cluster[];
  volatile: VolatileRules;
  split: Split;
  flow: { from: string; path: string; to: string; param: string; count: number }[];
  codeEndpoints: string[];
  coverage: Record<string, number>;
}

function mergeTemplates(exs: Ex[]) {
  // Data-driven: a path segment that takes many values under the same neighbours is an id, even when it does not look like one.
  for (let pass = 0; pass < 3; pass++) {
    const groups = new Map<string, Map<string, Ex[]>>();
    for (const x of exs) {
      if (ASSET_TYPES.has(x.resourceType) || !x.inScope) continue;
      const segs = x.parsed.pathTemplate.split("/");
      segs.forEach((seg, i) => {
        if (!seg || seg === "{id}") return;
        const key = `${x.parsed.method} ${x.parsed.host} ${segs.map((s, j) => (j === i ? "*" : s)).join("/")} ${i}`;
        if (!groups.has(key)) groups.set(key, new Map());
        const g = groups.get(key)!;
        if (!g.has(seg)) g.set(seg, []);
        g.get(seg)!.push(x);
      });
    }
    let changed = false;
    for (const [key, values] of groups) {
      if (values.size < 4) continue;
      const i = Number(key.slice(key.lastIndexOf(" ") + 1));
      // Sibling pages with distinct names (/patients, /search, /reports, /admin) are not ids: require data-like values.
      const dataLike = [...values.keys()].filter((v) => /\d/.test(v) || v.length > 24).length;
      if (dataLike < values.size * 0.75) continue;
      for (const [seg, list] of values)
        for (const x of list) {
          const segs = x.parsed.pathTemplate.split("/");
          if (segs[i] !== seg) continue;
          segs[i] = "{id}";
          x.parsed.pathTemplate = segs.join("/");
          changed = true;
        }
    }
    if (!changed) break;
  }
  for (const x of exs) {
    const u = new URL(x.url);
    const m = templateRegex(x.parsed.pathTemplate).exec(u.pathname);
    x.parsed.pathParams = m ? m.slice(1).map((s) => safeDecode(s)) : x.parsed.pathParams;
    x.parsed.key = `${x.parsed.method} ${x.parsed.host} ${x.parsed.pathTemplate}${x.parsed.discriminator ? ` [${x.parsed.discriminator.name}=${x.parsed.discriminator.value}]` : ""}`;
  }
}
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function classify(
  list: Ex[],
  probesOf: Map<string, ProbeEvent[]>,
  policy: Policy,
  key: string,
): { cls: RequestClass; reason: string } {
  const first = list[0]!;
  const u = new URL(first.url);
  const types = new Set(list.map((x) => x.resourceType));
  const ct = contentType(first.resHeaders);
  if (NOISE_HOSTS.test(u.host) || types.has("ping") || types.has("beacon") || NOISE_PATH.test(u.pathname))
    return { cls: "noise", reason: "analytics or telemetry" };
  const assetCt = /javascript|css|font|image\/|audio\/|video\/|wasm|octet-stream/.test(ct);
  const isGet = first.method === "GET";
  if (isGet && ([...types].every((t) => ASSET_TYPES.has(t)) || (assetCt && !/json|html/.test(ct)))) {
    const perInstance = new Map<string, Set<string>>();
    for (const x of list) {
      if (!perInstance.has(x.instance!)) perInstance.set(x.instance!, new Set());
      if (x.resBody) perInstance.get(x.instance!)!.add(x.resBody); // answers from the browser cache carry no body
    }
    if ([...perInstance.values()].every((s) => s.size <= 1))
      return { cls: "static", reason: "asset with stable bytes" };
  }
  if (!first.inScope)
    return isGet ? { cls: "static", reason: "third-party resource" } : { cls: "noise", reason: "third-party request" };
  const hasPassword = list.some(
    (x) =>
      x.parsed.form && Object.keys(x.parsed.form).some((k) => /^(pass(word|wd)?|pwd|clearpass|authpass)$/i.test(k)),
  );
  if (hasPassword) return { cls: "session", reason: "sends a password" };
  if (SESSION_PATH.test(u.pathname) && (!isGet || list.some((x) => x.status >= 300 && x.status < 400)))
    return { cls: "session", reason: "login, logout or keep-alive" };
  if (isGet || first.method === "HEAD" || first.method === "OPTIONS") {
    const user = policy[key];
    if (user?.by === "user" && user.decision === "write") return { cls: "write", reason: "policy (user)" };
    return { cls: "read", reason: "safe method" };
  }
  const entry = policy[key] ?? guessFromShape(first.method, first.url, contentType(first.reqHeaders), first.reqText);
  if (entry.decision === "read")
    return { cls: "read", reason: `policy: read (${entry.by}${entry.note ? `, ${entry.note}` : ""})` };
  void probesOf;
  return {
    cls: "write",
    reason: entry.decision === "write" ? `policy: write (${entry.by})` : "non-GET, not known to be a read",
  };
}

export function analyze(paths: AppPaths, config: AppConfig): Analysis {
  const corpus = loadCorpus(paths, config);
  const exs = corpus.exchanges;
  if (!exs.length) throw new Error("No captured exchanges. Run `sandbox capture` first.");
  const policyFile = join(paths.root, "policy.yaml");
  const policy: Policy = existsSync(policyFile) ? ((YAML.parse(readFileSyncText(policyFile)) as Policy) ?? {}) : {};

  mergeTemplates(exs);
  const probesOf = new Map<string, ProbeEvent[]>();
  for (const p of corpus.probes) {
    if (!probesOf.has(p.of)) probesOf.set(p.of, []);
    probesOf.get(p.of)!.push(p);
  }

  // Clusters, with ids that stay the same across runs when the endpoint is the same.
  const previous: Cluster[] = existsSync(join(paths.analysis, "clusters.json"))
    ? readJson(join(paths.analysis, "clusters.json"))
    : [];
  const idByKey = new Map(previous.map((c) => [c.key, c.id]));
  let nextNum = previous.reduce((m, c) => Math.max(m, Number(c.id.slice(2)) || 0), 0);
  const groups = new Map<string, Ex[]>();
  for (const x of exs) {
    x.instance = instanceKey(x.parsed);
    if (!groups.has(x.parsed.key)) groups.set(x.parsed.key, []);
    groups.get(x.parsed.key)!.push(x);
  }
  const clusters: Cluster[] = [];
  for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const id = idByKey.get(key) ?? `c_${String(++nextNum).padStart(4, "0")}`;
    const { cls, reason } = classify(list, probesOf, policy, key);
    for (const x of list) x.cluster = id;
    const p = list[0]!.parsed;
    clusters.push({
      id,
      key,
      method: p.method,
      host: p.host,
      pathTemplate: p.pathTemplate,
      discriminator: p.discriminator,
      class: cls,
      classReason: reason,
      count: list.length,
      instances: new Set(list.map((x) => x.instance)).size,
      resourceTypes: [...new Set(list.map((x) => x.resourceType))],
      contentType: contentType(list[list.length - 1]!.resHeaders) || undefined,
      statuses: [...new Set(list.map((x) => x.status))].sort(),
      volatileParams: [],
      exchangeIds: list.map((x) => x.id),
    });
  }
  const clusterOf = new Map(clusters.map((c) => [c.id, c]));
  const isWrite = (x: Ex) =>
    clusterOf.get(x.cluster!)?.class === "write" ||
    (clusterOf.get(x.cluster!)?.class === "session" && x.method !== "GET");

  // Volatile fields: a probe, or the same question asked twice with no write in between.
  const volatile: VolatileRules = {};
  const rulesFor = (c: string): Rules => (volatile[c] ??= { jsonPaths: [], textContexts: [], headers: [] });
  const writesByEpisode = new Map<string, number[]>();
  for (const x of exs)
    if (isWrite(x)) writesByEpisode.set(x.episode, [...(writesByEpisode.get(x.episode) ?? []), x.ts]);
  const writeBetween = (ep: string, from: number, to: number) =>
    (writesByEpisode.get(ep) ?? []).some((t) => t > from && t < to);
  const textOf = (x: { resBody?: string; resHeaders: ExchangeEvent["resHeaders"]; bodies: BodyStore }) =>
    x.resBody && isTextType(contentType(x.resHeaders)) ? x.bodies.text(x.resBody) : undefined;
  const probeGroups = new Map<string, typeof corpus.probes>();
  for (const p of corpus.probes) probeGroups.set(p.of, [...(probeGroups.get(p.of) ?? []), p]);
  for (const [of, group] of probeGroups) {
    const x = corpus.byId.get(of);
    if (!x || !x.cluster) continue;
    const isJson = /json/.test(contentType(x.resHeaders));
    // Probes are sent back to back, so nothing was written between them.
    for (let i = 1; i < group.length; i++) {
      const a = textOf(group[i - 1]!);
      const b = textOf(group[i]!);
      if (a !== undefined && b !== undefined && group[i - 1]!.status === group[i]!.status)
        learn(isJson, a, b, rulesFor(x.cluster));
    }
    // The original against a probe counts only when no write came after the original.
    const p = group[0]!;
    if (p.status !== x.status || x.probeAdopted || writeBetween(x.episode, x.ts, Number.POSITIVE_INFINITY)) continue;
    const a = textOf(x);
    const b = textOf(p);
    if (a !== undefined && b !== undefined) learn(isJson, a, b, rulesFor(x.cluster));
  }
  const byInstance = new Map<string, Ex[]>();
  for (const x of exs) {
    const k = `${x.episode} ${x.instance}`;
    if (!byInstance.has(k)) byInstance.set(k, []);
    byInstance.get(k)!.push(x);
  }
  for (const list of byInstance.values())
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      if (a.method !== "GET" || a.status !== b.status || writeBetween(a.episode, a.ts, b.ts)) continue;
      const ta = textOf(a);
      const tb = textOf(b);
      if (ta !== undefined && tb !== undefined)
        learn(/json/.test(contentType(a.resHeaders)), ta, tb, rulesFor(a.cluster!));
    }

  // Pages of one app share a shell (header, footer), so text rules learned on one page are applied to all:
  // an endpoint seen only once has no evidence of its own.
  const shared = [...new Set(Object.values(volatile).flatMap((r) => r.textContexts))];
  if (shared.length) volatile["*"] = { jsonPaths: [], textContexts: shared, headers: [] };

  // Value flow: a value in one response that shows up in a later request (foreign keys, navigation order).
  const flowCount = new Map<string, number>();
  const seenValues = new Map<string, { cluster: string; path: string }>();
  for (const x of [...exs].sort((a, b) =>
    a.episode === b.episode ? a.ts - b.ts : a.episode.localeCompare(b.episode),
  )) {
    const cls = clusterOf.get(x.cluster!)!.class;
    if (cls === "static" || cls === "noise") continue;
    const params = requestParams(x.parsed);
    for (const [param, value] of Object.entries(params)) {
      const src = seenValues.get(value);
      if (src && src.cluster !== x.cluster) {
        const k = `${src.cluster}\t${src.path}\t${x.cluster}\t${param}`;
        flowCount.set(k, (flowCount.get(k) ?? 0) + 1);
      }
    }
    const text = textOf(x);
    if (text === undefined || text.length > 2_000_000) continue;
    if (/json/.test(contentType(x.resHeaders))) {
      try {
        const leaves: Record<string, string> = {};
        collectLeaves(JSON.parse(text), "", leaves);
        for (const [path, v] of Object.entries(leaves))
          if (/^[\w-]{2,64}$/.test(v) && !/^(true|false|null|\d)$/.test(v) && !seenValues.has(v))
            seenValues.set(v, { cluster: x.cluster!, path });
      } catch {}
    } else
      for (const m of text.matchAll(/(?:href|action|value|data-[\w-]+)=["']([^"']{1,200})["']/g))
        for (const id of m[1]!.match(/\d{2,}/g) ?? [])
          if (!seenValues.has(id)) seenValues.set(id, { cluster: x.cluster!, path: "html" });
  }
  const flow = [...flowCount].map(([k, count]) => {
    const [from, path, to, param] = k.split("\t") as [string, string, string, string];
    return { from, path, to, param, count };
  });

  // Split: what the builder may see, and what is kept back to check the copy.
  const split: Split = { build: [], heldOut: [], l3: [] };
  const held = new Set<string>();
  for (const c of clusters) {
    if (c.class !== "read" && c.class !== "write") continue;
    const instances = [...new Set(c.exchangeIds.map((id) => corpus.byId.get(id)!.instance!))];
    if (instances.length < 2) continue;
    const heldInstances = new Set(instances.filter((_, i) => i % 2 === 1));
    for (const id of c.exchangeIds) if (heldInstances.has(corpus.byId.get(id)!.instance!)) held.add(id);
  }
  const byEpisode = new Map<string, Ex[]>();
  for (const x of exs) byEpisode.set(x.episode, [...(byEpisode.get(x.episode) ?? []), x]);
  for (const list of byEpisode.values()) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < list.length; i++) {
      const w = list[i]!;
      if (clusterOf.get(w.cluster!)?.class !== "write" || w.status >= 400) continue;
      const reads: string[] = [];
      for (let j = i + 1; j < list.length; j++) {
        const r = list[j]!;
        const rc = clusterOf.get(r.cluster!)!.class;
        if (rc === "write") break;
        if (rc === "read" && r.status === 200) reads.push(r.id);
      }
      if (reads.length) split.l3.push({ write: w.id, reads });
    }
  }
  for (const x of exs) {
    const cls = clusterOf.get(x.cluster!)!.class;
    if (cls !== "read" && cls !== "write") continue;
    (held.has(x.id) ? split.heldOut : split.build).push(x.id);
  }

  // Endpoints named in the app's JavaScript that were never observed.
  const observed = clusters.filter((c) => c.class !== "static");
  const codeEndpoints = new Set<string>();
  const scanned = new Set<string>();
  for (const x of exs) {
    if (!x.inScope || !x.resBody || scanned.has(x.resBody) || !/javascript/.test(contentType(x.resHeaders))) continue;
    scanned.add(x.resBody);
    const js = x.bodies.text(x.resBody);
    if (js.length > 5_000_000) continue;
    for (const m of js.matchAll(/["'`](\/[A-Za-z0-9_\-./]{2,80}?)(?:["'`?]|\$\{|['"`]\s*\+)/g)) {
      const path = m[1]!;
      if (!/[a-z]/i.test(path) || /\.(js|css|png|svg|jpg|gif|woff2?|map|ico)$/i.test(path) || path.startsWith("//"))
        continue;
      const hit = observed.some(
        (c) =>
          c.pathTemplate === path ||
          c.pathTemplate.startsWith(path.endsWith("/") ? path : `${path}/`) ||
          templateRegex(c.pathTemplate).test(path),
      );
      if (!hit) codeEndpoints.add(path);
    }
  }

  const coverage: Record<string, number> = {
    exchanges: exs.length,
    clusters: clusters.length,
    actions: corpus.actions.length,
  };
  for (const c of clusters) coverage[c.class] = (coverage[c.class] ?? 0) + 1;
  coverage.unobservedInCode = codeEndpoints.size;

  ensureDir(paths.analysis);
  writeJson(join(paths.analysis, "clusters.json"), clusters);
  writeJson(join(paths.analysis, "volatile.json"), volatile);
  writeJson(join(paths.analysis, "flow.json"), flow);
  writeJson(join(paths.analysis, "split.json"), split);
  writeJson(join(paths.analysis, "code-endpoints.json"), [...codeEndpoints].sort());
  writeJson(join(paths.analysis, "coverage.json"), coverage);
  writeFileSync(join(paths.analysis, "spec.yaml"), YAML.stringify(openApi(clusters, corpus)));

  // Held-out exchanges go to a directory the builder never receives.
  rmSync(paths.heldOut, { recursive: true, force: true });
  ensureDir(paths.heldOut);
  writeJson(join(paths.heldOut, "ids.json"), split.heldOut);

  return { clusters, volatile, split, flow, codeEndpoints: [...codeEndpoints].sort(), coverage };
}

import { readFileSync } from "node:fs";
const readFileSyncText = (f: string) => readFileSync(f, "utf8");

function collectLeaves(value: unknown, path: string, out: Record<string, string>) {
  if (value === null || typeof value !== "object") {
    out[path] = String(value);
    return;
  }
  if (Array.isArray(value)) value.slice(0, 200).forEach((v) => collectLeaves(v, `${path}[*]`, out));
  else for (const [k, v] of Object.entries(value)) collectLeaves(v, path ? `${path}.${k}` : k, out);
}

function shapeOf(value: unknown): unknown {
  if (value === null) return { nullable: true };
  if (Array.isArray(value)) return { type: "array", items: value.length ? shapeOf(value[0]) : {} };
  if (typeof value === "object")
    return { type: "object", properties: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v)])) };
  return { type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string" };
}

/** A small OpenAPI description of the JSON endpoints, inferred from one example each. */
export function openApi(clusters: Cluster[], corpus: Corpus) {
  const pathsObj: Record<string, Record<string, unknown>> = {};
  for (const c of clusters) {
    if (c.class !== "read" && c.class !== "write") continue;
    const x = corpus.byId.get(c.exchangeIds[c.exchangeIds.length - 1]!)!;
    if (!/json/.test(contentType(x.resHeaders))) continue;
    let schema: unknown = {};
    try {
      schema = shapeOf(JSON.parse(x.bodies.text(x.resBody)));
    } catch {}
    const path = c.pathTemplate.replace(
      /\{id\}/g,
      (() => {
        let n = 0;
        return () => `{id${++n}}`;
      })(),
    );
    pathsObj[path] ??= {};
    pathsObj[path]![c.method.toLowerCase()] = {
      operationId: c.id,
      "x-sandbox-class": c.class,
      ...(c.discriminator ? { "x-discriminator": c.discriminator } : {}),
      responses: { [String(x.status)]: { description: "observed", content: { "application/json": { schema } } } },
    };
  }
  return { openapi: "3.0.3", info: { title: "Inferred from captures", version: "0" }, paths: pathsObj };
}

/** Load the saved analysis and attach cluster ids to a freshly loaded corpus. */
export function loadAnalysis(paths: AppPaths, config: AppConfig) {
  const clusters = readJson<Cluster[]>(join(paths.analysis, "clusters.json"));
  const volatile = readJson<VolatileRules>(join(paths.analysis, "volatile.json"));
  const split = readJson<Split>(join(paths.analysis, "split.json"));
  const corpus = loadCorpus(paths, config);
  const byExchange = new Map<string, Cluster>();
  for (const c of clusters) for (const id of c.exchangeIds) byExchange.set(id, c);
  for (const x of corpus.exchanges) {
    const c = byExchange.get(x.id) ?? matchCluster(clusters, x.parsed, new URL(x.url).pathname)?.cluster;
    if (!c) continue;
    x.cluster = c.id;
    const m = templateRegex(c.pathTemplate).exec(new URL(x.url).pathname);
    x.parsed.pathTemplate = c.pathTemplate;
    x.parsed.pathParams = m ? m.slice(1).map(safeDecode) : [];
    x.parsed.key = c.key;
    x.instance = instanceKey(x.parsed);
  }
  return { clusters, volatile, split, corpus };
}
