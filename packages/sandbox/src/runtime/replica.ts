import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRequest } from "../analyze/cluster.js";
import { type Ex, loadAnalysis } from "../analyze/index.js";
import type { AppConfig, Cluster, Headers, Ledger, Split } from "../types.js";
import { type AppPaths, ensureDir, header, isTextType, parseBody, readJson, sha256 } from "../util.js";

const require = createRequire(import.meta.url);

const DROP_HEADERS =
  /^(content-length|content-encoding|transfer-encoding|connection|keep-alive|alt-svc|strict-transport-security|report-to|nel|content-security-policy-report-only|date|age|etag|last-modified|expires)$/i;

export interface SandboxRequest {
  method: string;
  /** Absolute URL at the app's original origin. */
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface SandboxResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  /** How the answer was produced. */
  served: "static" | "replay" | "generated" | "stub" | "noise" | "uncaptured" | "external" | "error";
  cluster?: string;
  exchange?: string;
}

export interface LogEntry {
  n: number;
  at: string;
  method: string;
  url: string;
  status: number;
  served: SandboxResponse["served"];
  cluster?: string;
  key?: string;
  error?: string;
}

export interface RouteContext {
  method: string;
  url: URL;
  path: string;
  /** Values of the {id} segments in the cluster's path template, in order. */
  params: string[];
  query: Record<string, string>;
  form: Record<string, string>;
  json: unknown;
  text: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  db: {
    get(sql: string, ...args: unknown[]): Record<string, unknown> | undefined;
    all(sql: string, ...args: unknown[]): Record<string, unknown>[];
    run(sql: string, ...args: unknown[]): { changes: number; lastInsertRowid: number };
  };
  /** Per-browser-session scratch space. */
  session: Record<string, unknown>;
  now(): Date;
  respond(status: number, body?: string | Buffer, headers?: Record<string, string>): RouteResult;
  json_(status: number, value: unknown, headers?: Record<string, string>): RouteResult;
  html(status: number, body: string, headers?: Record<string, string>): RouteResult;
  redirect(location: string, status?: number): RouteResult;
  /** The recorded answer for this exact request, if one exists. */
  recorded(): RouteResult | undefined;
}
export interface RouteResult {
  status: number;
  body: Buffer;
  headers: Record<string, string>;
}
export interface RouteModule {
  /** Cluster id from analysis/clusters.json, or use `match`. */
  cluster?: string;
  match?: { method: string; path: string; discriminator?: string };
  kind: "read" | "write";
  handle(ctx: RouteContext): RouteResult | undefined | Promise<RouteResult | undefined>;
}

export interface ReplicaOptions {
  /** "all": replay may use every recording. "build": only what the builder was allowed to see (used by the verifier). */
  replaySet?: "all" | "build";
  copy?: number | string;
  /** "capture": ctx.now() continues from the end of the capture. "today": the real clock. */
  clock?: "capture" | "today";
  /** Skip generated routes: pure replay. */
  replayOnly?: boolean;
}

type Db = {
  prepare(sql: string): {
    get(...a: unknown[]): unknown;
    all(...a: unknown[]): unknown[];
    run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  exec(sql: string): void;
  close(): void;
};

export class Replica {
  clusters: Cluster[] = [];
  private split!: Split;
  private byInstance = new Map<string, Ex[]>();
  private byCluster = new Map<string, Ex[]>();
  private routes = new Map<string, RouteModule>();
  private db: Db | null = null;
  private dbFile: string;
  private sessions = new Map<string, Record<string, unknown>>();
  private startedAt = Date.now();
  private captureEnd = Date.now();
  readonly log: LogEntry[] = [];
  routeErrors: string[] = [];

  constructor(
    readonly paths: AppPaths,
    readonly config: AppConfig,
    readonly opts: ReplicaOptions = {},
  ) {
    this.dbFile = join(ensureDir(paths.run), `copy-${opts.copy ?? 0}.db`);
  }

  async load() {
    const { clusters, split, corpus } = loadAnalysis(this.paths, this.config);
    this.clusters = clusters;
    this.split = split;
    const allowed = this.opts.replaySet === "build" ? new Set(split.build) : null;
    this.byInstance.clear();
    this.byCluster.clear();
    const classOf = new Map(clusters.map((c) => [c.id, c.class]));
    for (const x of corpus.exchanges) {
      if (!x.cluster) continue;
      const cls = classOf.get(x.cluster);
      if (allowed && (cls === "read" || cls === "write") && !allowed.has(x.id)) continue;
      push(this.byInstance, x.instance!, x);
      push(this.byCluster, x.cluster, x);
    }
    const ends = corpus.exchanges.map((x) => x.endTs);
    void ends;
    for (const id of new Set(corpus.exchanges.map((x) => x.capture))) {
      const m = readJson<{ endedAt?: string }>(join(this.paths.captures, id, "manifest.json"));
      if (m.endedAt) this.captureEnd = new Date(m.endedAt).getTime();
    }
    await this.loadRoutes();
    this.reset();
  }

  async loadRoutes() {
    this.routes.clear();
    this.routeErrors = [];
    if (this.opts.replayOnly) return;
    const dir = join(this.paths.replica, "routes");
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      if (!/\.(ts|js|mjs)$/.test(f) || f.endsWith(".d.ts")) continue;
      try {
        const file = join(dir, f);
        const mod = (await import(`${pathToFileURL(file).href}?v=${sha256(readFileSync(file)).slice(0, 12)}`)) as {
          default?: RouteModule;
        };
        const route = mod.default;
        if (!route || typeof route.handle !== "function" || (!route.cluster && !route.match))
          throw new Error("must default-export { cluster or match, kind, handle }");
        const m = route.match;
        const found = route.cluster
          ? this.clusters.filter((c) => c.id === route.cluster)
          : this.clusters.filter(
              (c) =>
                c.method === m!.method.toUpperCase() &&
                c.pathTemplate === m!.path &&
                (!m!.discriminator || `${c.discriminator?.name}=${c.discriminator?.value}` === m!.discriminator),
            );
        if (!found.length)
          throw new Error(
            route.cluster ? `unknown cluster ${route.cluster}` : `no recorded endpoint matches ${m!.method} ${m!.path}`,
          );
        for (const c of found) this.routes.set(c.id, route);
      } catch (e) {
        this.routeErrors.push(`${f}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }

  hasRoute(cluster: string) {
    return this.routes.has(cluster);
  }

  /** Restore the seed database and clear sessions. */
  reset() {
    this.db?.close();
    this.db = null;
    this.sessions.clear();
    this.log.length = 0;
    this.startedAt = Date.now();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(this.dbFile + suffix, { force: true });
    const seed = materializeSeed(this.paths);
    if (!seed) return;
    copyFileSync(seed, this.dbFile);
    this.db = new (sqlite().DatabaseSync)(this.dbFile);
  }

  /** The whole database as JSON, for test assertions. */
  state(): Record<string, unknown[]> {
    if (!this.db) return {};
    const out: Record<string, unknown[]> = {};
    const tables = this.db
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
      .all() as { name: string }[];
    for (const t of tables) out[t.name] = this.db.prepare(`select * from "${t.name}"`).all();
    return out;
  }

  ledger(): Ledger | undefined {
    const file = join(this.paths.replica, "ledger.json");
    return existsSync(file) ? readJson<Ledger>(file) : undefined;
  }

  close(removeDb = false) {
    this.db?.close();
    this.db = null;
    if (removeDb) for (const suffix of ["", "-wal", "-shm"]) rmSync(this.dbFile + suffix, { force: true });
  }

  now(): Date {
    return this.opts.clock === "today" ? new Date() : new Date(this.captureEnd + (Date.now() - this.startedAt));
  }

  async handle(req: SandboxRequest): Promise<SandboxResponse> {
    const res = await this.answer(req).catch(
      (e: Error): SandboxResponse => ({
        status: 500,
        headers: [["content-type", "text/plain"]],
        body: Buffer.from(`sandbox error: ${e.message}`),
        served: "error",
      }),
    );
    res.headers = res.headers.filter(([k]) => !DROP_HEADERS.test(k));
    res.headers.push(["x-sandbox", res.served]);
    if (res.cluster) res.headers.push(["x-sandbox-cluster", res.cluster]);
    const entry: LogEntry = {
      n: this.log.length + 1,
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      status: res.status,
      served: res.served,
      cluster: res.cluster,
    };
    if (res.served === "error") entry.error = res.body.toString("utf8").slice(0, 300);
    // The browser's own background requests (updates, sign-in, autofill) are not the app's or the agent's:
    // they come from no page. Refuse them like any other outside address, but keep them out of the log.
    const fromAppPage = [req.headers.referer, req.headers.origin].some((h) => {
      try {
        return !!h && this.config.origins.includes(new URL(h).origin);
      } catch {
        return false;
      }
    });
    const fromNoPage =
      !fromAppPage &&
      (req.headers["sec-fetch-site"] ?? "none") === "none" &&
      req.headers["sec-fetch-mode"] !== "navigate";
    if (!(res.served === "external" && fromNoPage)) this.log.push({ ...entry, n: this.log.length + 1 });
    return res;
  }

  private async answer(req: SandboxRequest): Promise<SandboxResponse> {
    const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const text = req.body.length && (isTextType(ct) || !ct) ? req.body.toString("utf8") : "";
    const method = req.method.toUpperCase();
    const { parsed, cluster, instance } = resolveRequest(this.clusters, method, req.url, ct, text);
    const inScope = this.config.origins.includes(parsed.origin);
    const empty = Buffer.alloc(0);
    if (method === "OPTIONS" && !cluster)
      return {
        status: 204,
        headers: [
          ["access-control-allow-origin", req.headers.origin ?? "*"],
          ["access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS"],
          ["access-control-allow-headers", req.headers["access-control-request-headers"] ?? "*"],
          ["access-control-allow-credentials", "true"],
        ],
        body: empty,
        served: "stub",
      };
    if (!cluster) {
      if (!inScope)
        return {
          status: 502,
          headers: [["content-type", "text/plain"]],
          body: Buffer.from("sandbox: request to a host outside the copy"),
          served: "external",
        };
      // Browsers ask for /favicon.ico by themselves. An app that has none is not missing a recording.
      if (method === "GET" && new URL(req.url).pathname === "/favicon.ico")
        return { status: 404, headers: [["content-type", "text/plain"]], body: empty, served: "noise" };
      return uncaptured(`no recording of ${method} ${new URL(req.url).pathname}`);
    }

    const route = this.routes.get(cluster.id);
    if (route) {
      const result = await route.handle(this.context(req, parsed, text, ct, instance));
      if (result)
        return {
          status: result.status,
          headers: Object.entries(result.headers),
          body: result.body,
          served: "generated",
          cluster: cluster.id,
        };
      return { ...uncaptured(`route ${cluster.id} returned nothing`), cluster: cluster.id };
    }

    if (cluster.class === "noise")
      return { status: 204, headers: [], body: empty, served: "noise", cluster: cluster.id };
    const exact = pick(this.byInstance.get(instance));
    if (cluster.class === "session") {
      // Any login succeeds as the captured user: answer with the recorded success, whatever was typed.
      const x = exact && exact.status < 400 ? exact : (pick(this.byCluster.get(cluster.id)) ?? exact);
      return x ? this.replay(x, "stub") : { ...uncaptured("no session recording"), cluster: cluster.id };
    }
    if (exact) return this.replay(exact, cluster.class === "static" ? "static" : "replay");
    return {
      ...uncaptured(`${cluster.key}: this request was never recorded with these parameters`),
      cluster: cluster.id,
    };
  }

  private replay(x: Ex, served: SandboxResponse["served"]): SandboxResponse {
    const headers: Headers = [];
    for (const [k, v] of x.resHeaders) {
      if (/^set-cookie$/i.test(k))
        for (const line of v.split("\n"))
          headers.push([
            k,
            line
              .replace(/;\s*secure/gi, (m) => (x.url.startsWith("https:") ? m : ""))
              .replace(/;\s*domain=[^;]+/gi, ""),
          ]);
      else headers.push([k, v]);
    }
    return {
      status: x.status === 304 ? 200 : x.status,
      headers,
      body: x.resBody ? x.bodies.get(x.resBody) : Buffer.alloc(0),
      served,
      cluster: x.cluster,
      exchange: x.id,
    };
  }

  private context(
    req: SandboxRequest,
    parsed: ReturnType<typeof resolveRequest>["parsed"],
    text: string,
    ct: string,
    instance: string,
  ): RouteContext {
    const { form, json } = text ? parseBody(ct, text) : {};
    const cookies: Record<string, string> = {};
    for (const part of (req.headers.cookie ?? "").split(/;\s*/)) {
      const i = part.indexOf("=");
      if (i > 0) cookies[part.slice(0, i)] = part.slice(i + 1);
    }
    const sid = Object.values(cookies).join("|") || "anonymous";
    if (!this.sessions.has(sid)) this.sessions.set(sid, {});
    const db = this.db;
    const need = () => {
      if (!db) throw new Error("this replica has no database (no seed.db or schema.sql)");
      return db;
    };
    const mk = (status: number, body: string | Buffer = "", headers: Record<string, string> = {}): RouteResult => ({
      status,
      body: typeof body === "string" ? Buffer.from(body) : body,
      headers,
    });
    const args = (a: unknown[]) => a.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v));
    return {
      method: parsed.method,
      url: new URL(req.url),
      path: new URL(req.url).pathname,
      params: parsed.pathParams,
      query: parsed.query,
      form: form ?? {},
      json,
      text,
      headers: req.headers,
      cookies,
      db: {
        get: (sql, ...a) =>
          need()
            .prepare(sql)
            .get(...args(a)) as Record<string, unknown> | undefined,
        all: (sql, ...a) =>
          need()
            .prepare(sql)
            .all(...args(a)) as Record<string, unknown>[],
        run: (sql, ...a) => {
          const r = need()
            .prepare(sql)
            .run(...args(a));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
      },
      session: this.sessions.get(sid)!,
      now: () => this.now(),
      respond: mk,
      json_: (status, value, headers = {}) =>
        mk(status, JSON.stringify(value), { "content-type": "application/json", ...headers }),
      html: (status, body, headers = {}) =>
        mk(status, body, { "content-type": "text/html; charset=utf-8", ...headers }),
      redirect: (location, status = 302) => mk(status, "", { location }),
      recorded: () => {
        const x = pick(this.byInstance.get(instance));
        if (!x) return undefined;
        const r = this.replay(x, "replay");
        return {
          status: r.status,
          body: r.body,
          headers: Object.fromEntries(r.headers.filter(([k]) => !/^set-cookie$/i.test(k))),
        };
      },
    };
  }

  /** Recorded exchange by id (used by the verifier). */
  exchangesOf(cluster: string): Ex[] {
    return this.byCluster.get(cluster) ?? [];
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The copy shows the app as it was at the end of the capture: prefer the latest successful answer. */
function pick(list: Ex[] | undefined): Ex | undefined {
  if (!list?.length) return undefined;
  for (let i = list.length - 1; i >= 0; i--)
    if (list[i]!.status >= 200 && list[i]!.status < 300 && list[i]!.status !== 204 && list[i]!.resBody) return list[i];
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.status >= 200 && list[i]!.status < 300) return list[i];
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.status < 400 && list[i]!.status !== 304) return list[i];
  return list[list.length - 1];
}

function uncaptured(why: string): SandboxResponse {
  return {
    status: 501,
    headers: [
      ["content-type", "text/plain"],
      ["x-sandbox-reason", why.slice(0, 200)],
    ],
    body: Buffer.from(`sandbox: uncaptured. ${why}`),
    served: "uncaptured",
  };
}

function sqlite() {
  const emit = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) =>
    String(w).includes("SQLite")
      ? undefined
      : (emit as (...a: unknown[]) => void).call(process, w, ...rest)) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as { DatabaseSync: new (file: string) => Db };
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * seed.db is the database every copy starts from. It is rebuilt from schema.sql + seed.sql whenever they are
 * newer, so those two text files are the source of truth and can be edited by hand.
 */
export function materializeSeed(paths: AppPaths): string | undefined {
  const seed = join(paths.replica, "seed.db");
  const schema = join(paths.replica, "schema.sql");
  const seedSql = join(paths.replica, "seed.sql");
  if (!existsSync(schema)) return existsSync(seed) ? seed : undefined;
  const newest = Math.max(statSync(schema).mtimeMs, existsSync(seedSql) ? statSync(seedSql).mtimeMs : 0);
  if (existsSync(seed) && statSync(seed).mtimeMs >= newest) return seed;
  rmSync(seed, { force: true });
  const db = new (sqlite().DatabaseSync)(seed);
  try {
    db.exec(readFileSync(schema, "utf8"));
    if (existsSync(seedSql)) db.exec(readFileSync(seedSql, "utf8"));
  } finally {
    db.close();
  }
  return seed;
}

export { header };
