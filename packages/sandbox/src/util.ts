import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import YAML from "yaml";
import type { AppConfig, CaptureEvent, Headers, Manifest } from "./types.js";

export const TOOL_VERSION = "0.1.0";

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, value: unknown) {
  ensureDir(dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function header(headers: Headers, name: string): string | undefined {
  const n = name.toLowerCase();
  return headers.find(([k]) => k.toLowerCase() === n)?.[1];
}

export function contentType(headers: Headers): string {
  return (header(headers, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

export const isTextType = (ct: string) =>
  /^text\/|json|javascript|xml|x-www-form-urlencoded|svg|html/.test(ct) && !/font|octet/.test(ct);

/** Content-addressed body store. */
export class BodyStore {
  constructor(readonly dir: string) {
    ensureDir(dir);
  }
  put(data: Buffer | string): string {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    const hash = sha256(buf);
    const file = join(this.dir, hash);
    if (!existsSync(file)) writeFileSync(file, buf);
    return hash;
  }
  has(hash: string) {
    return existsSync(join(this.dir, hash));
  }
  get(hash: string | undefined): Buffer {
    if (!hash) return Buffer.alloc(0);
    return readFileSync(join(this.dir, hash));
  }
  text(hash: string | undefined): string {
    return this.get(hash).toString("utf8");
  }
}

// ---------- locations ----------

/** The .sandbox folder for a working directory. Works from inside it too, which is where the builder's agents run. */
export function sandboxRoot(cwd = process.cwd()) {
  const parts = resolve(cwd).split(sep);
  const at = parts.lastIndexOf(".sandbox");
  return at >= 0 ? parts.slice(0, at + 1).join(sep) : resolve(cwd, ".sandbox");
}

export function appNameFromUrl(url: string) {
  return new URL(url).host.replace(/[^a-z0-9.-]/gi, "_").replace(/:/g, "_");
}

export interface AppPaths {
  root: string;
  config: string;
  profile: string;
  captures: string;
  analysis: string;
  replica: string;
  heldOut: string;
  build: string;
  run: string;
  drift: string;
  ca: string;
}

export function appPaths(app: string, cwd = process.cwd()): AppPaths {
  const root = join(sandboxRoot(cwd), app);
  return {
    root,
    config: join(root, "sandbox.config.yaml"),
    profile: join(root, "profile"),
    captures: join(root, "captures"),
    analysis: join(root, "analysis"),
    replica: join(root, "replica"),
    heldOut: join(root, "held-out"),
    build: join(root, "build"),
    run: join(root, "run"),
    drift: join(root, "drift"),
    ca: join(root, "ca"),
  };
}

/** Pick the app: explicit name, or the only one under .sandbox/. */
export function resolveApp(name?: string, cwd = process.cwd()): string {
  if (name) return name;
  const root = sandboxRoot(cwd);
  const apps = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "sandbox.config.yaml")))
        .map((d) => d.name)
    : [];
  if (apps.length === 1) return apps[0]!;
  if (apps.length === 0) throw new Error("No app found. Run `sandbox init <url>` first.");
  throw new Error(`Several apps found (${apps.join(", ")}). Pass --app <name>.`);
}

export function loadConfig(paths: AppPaths): AppConfig {
  return YAML.parse(readFileSync(paths.config, "utf8")) as AppConfig;
}

export function saveConfig(paths: AppPaths, config: AppConfig) {
  ensureDir(paths.root);
  writeFileSync(paths.config, YAML.stringify(config));
}

// ---------- capture bundles ----------

export interface Bundle {
  dir: string;
  manifest: Manifest;
  events: CaptureEvent[];
  bodies: BodyStore;
}

export function listCaptures(paths: AppPaths): string[] {
  if (!existsSync(paths.captures)) return [];
  return readdirSync(paths.captures)
    .filter((d) => existsSync(join(paths.captures, d, "manifest.json")))
    .sort();
}

export function readEvents(dir: string): CaptureEvent[] {
  const epDir = join(dir, "episodes");
  if (!existsSync(epDir)) return [];
  const out: CaptureEvent[] = [];
  for (const f of readdirSync(epDir).sort((a, b) => Number.parseInt(a) - Number.parseInt(b))) {
    const ep = f.replace(/\.jsonl$/, "");
    for (const line of readFileSync(join(epDir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line) as CaptureEvent;
      (ev as CaptureEvent & { episode: string }).episode = ep;
      out.push(ev);
    }
  }
  return out;
}

/**
 * Load a capture. `scrubbed: true` reads the scrubbed copy, which is what analysis, the builder and the
 * replica use; the raw copy never leaves the machine.
 */
export function loadBundle(paths: AppPaths, id: string, scrubbed = true): Bundle {
  const base = join(paths.captures, id);
  const dir = scrubbed ? join(base, "scrubbed") : base;
  if (scrubbed && !existsSync(join(dir, "episodes")))
    throw new Error(`Capture ${id} has not been scrubbed. Run \`sandbox scrub\`.`);
  return {
    dir,
    manifest: readJson<Manifest>(join(base, "manifest.json")),
    events: readEvents(dir)
      .map((e) => ({ ...e, id: `${id}:${e.id}` }) as CaptureEvent)
      .map((e) => qualify(e, id)),
    bodies: new BodyStore(join(dir, "bodies")),
  };
}

function qualify(e: CaptureEvent, id: string): CaptureEvent {
  const q = (x: string | null | undefined) => (x ? `${id}:${x}` : x);
  if (e.type === "exchange" || e.type === "ws") return { ...e, causedBy: q(e.causedBy) ?? null };
  if (e.type === "probe") return { ...e, of: q(e.of)! };
  if (e.type === "action")
    return { ...e, snapshotBefore: q(e.snapshotBefore) ?? undefined, snapshotAfter: q(e.snapshotAfter) ?? undefined };
  return e;
}

export function episodeOf(e: CaptureEvent): string {
  return `${e.id.split(":")[0]}/${(e as CaptureEvent & { episode?: string }).episode ?? "1"}`;
}

export function log(msg: string) {
  process.stderr.write(`${msg}\n`);
}

export function parseBody(ct: string, text: string): { form?: Record<string, string>; json?: unknown } {
  if (/json/.test(ct) || /^\s*[[{]/.test(text)) {
    try {
      return { json: JSON.parse(text) };
    } catch {}
  }
  if (/x-www-form-urlencoded/.test(ct) || (/^[\w%.[\]-]+=/.test(text) && !text.includes("\n"))) {
    const form: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) form[k] = v;
    return { form };
  }
  return {};
}
