import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { instanceKey, resolveRequest } from "../analyze/cluster.js";
import { type Ex, loadAnalysis, loadCorpus } from "../analyze/index.js";
import { normalizeBody } from "../analyze/normalize.js";
import { type CaptureOptions, capture } from "../capture/index.js";
import type { AppConfig, Cluster, Manifest } from "../types.js";
import { type AppPaths, contentType, ensureDir, isTextType, readJson, writeJson } from "../util.js";

export type Severity = "breaking" | "behavioural" | "cosmetic";
export interface DriftItem {
  severity: Severity;
  area: "api" | "ui" | "assets";
  cluster?: string;
  what: string;
  detail?: string;
}
export interface DriftReport {
  app: string;
  checkedAt: string;
  baseline: string[];
  capture: string;
  probed: number;
  items: DriftItem[];
  worst: Severity | "none";
  affectedClusters: string[];
}

export class SessionExpired extends Error {
  constructor() {
    super("The app's session has expired. Run `sandbox login` and try again.");
  }
}

const LOGIN_RE = /(^|[/_.-])(login|signin|sign-in|sso|authenticate)([/_.-]|$)/i;
const CONTROL_ROLES = /^(button|textbox|combobox|checkbox|radio|tab|menuitem|searchbox|switch|slider|spinbutton)$/;

/** Field names and types of a JSON value, values removed. */
function shape(value: unknown, path = "", out: Record<string, string> = {}): Record<string, string> {
  if (value === null) out[path] = "null";
  else if (Array.isArray(value)) {
    out[path] = "array";
    if (value.length) shape(value[0], `${path}[]`, out);
  } else if (typeof value === "object") {
    out[path] = "object";
    for (const [k, v] of Object.entries(value)) shape(v, path ? `${path}.${k}` : k, out);
  } else out[path] = typeof value;
  return out;
}

/** The structure of an HTML page that an agent depends on: forms, fields, ids. Text and data removed. */
function htmlStructure(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/<(form|input|select|textarea|button)\b([^>]*)>/gi)) {
    const tag = m[1]!.toLowerCase();
    const attrs = m[2] ?? "";
    const name = /\bname=["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    const id = /\bid=["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    const type = /\btype=["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    if (type === "hidden") continue;
    const label = name ?? id;
    if (label) out.add(`${tag} ${label.replace(/\d+/g, "0")}`);
  }
  return out;
}

/** Controls in an accessibility snapshot: role and name, numbers masked. Links count only inside navigation. */
export function controlsOf(aria: string): Set<string> {
  const out = new Set<string>();
  let navIndent = -1;
  for (const line of aria.split("\n")) {
    const m = /^(\s*)- (\w+)(?: "([^"]*)")?/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    if (navIndent >= 0 && indent <= navIndent) navIndent = -1;
    const role = m[2]!;
    if (role === "navigation") navIndent = indent;
    const name = (m[3] ?? "").replace(/\d+/g, "0").trim();
    if (!name) continue;
    if (CONTROL_ROLES.test(role) || (role === "link" && navIndent >= 0)) out.add(`${role} "${name}"`);
  }
  return out;
}

const diffSets = (a: Set<string>, b: Set<string>) => ({
  removed: [...a].filter((x) => !b.has(x)),
  added: [...b].filter((x) => !a.has(x)),
});

/**
 * Re-check the live app against the last recording, read-only, using the saved login.
 * Compares structure, not data: a new patient is not drift; a renamed button or a removed field is.
 */
export async function drift(
  paths: AppPaths,
  config: AppConfig,
  opts: Pick<CaptureOptions, "headless" | "bundledBrowser"> & { maxPages?: number } = {},
): Promise<DriftReport> {
  const { clusters, volatile, corpus } = loadAnalysis(paths, config);
  const classOf = new Map(clusters.map((c) => [c.id, c]));
  const latest = new Map<string, Ex>();
  for (const x of corpus.exchanges) {
    const c = classOf.get(x.cluster ?? "");
    if (!c || x.method !== "GET" || x.status !== 200 || !x.inScope) continue;
    if (c.class !== "read" && c.class !== "static") continue;
    latest.set(x.instance!, x);
  }
  const pages = [...latest.values()].filter(
    (x) =>
      x.resourceType === "document" &&
      classOf.get(x.cluster!)!.class === "read" &&
      !LOGIN_RE.test(new URL(x.url).pathname),
  );
  // One page per endpoint is enough to see structure; keep two for some variety.
  const perCluster = new Map<string, number>();
  const visit = pages
    .filter((x) => {
      const n = (perCluster.get(x.cluster!) ?? 0) + 1;
      perCluster.set(x.cluster!, n);
      return n <= 2;
    })
    .slice(0, opts.maxPages ?? 40);
  const apis = [...latest.values()].filter(
    (x) => ["xhr", "fetch"].includes(x.resourceType) && classOf.get(x.cluster!)!.class === "read",
  );

  const ariaNow = new Map<string, string>();
  const captureId = await capture(paths, config, {
    mode: "script",
    manifestMode: "drift",
    gate: true,
    allowWrites: false,
    probe: false,
    headless: opts.headless,
    bundledBrowser: opts.bundledBrowser,
    label: "drift check",
    script: async (page, { recorder, context }) => {
      for (const x of visit) {
        recorder.markAction(page, "navigate", x.url);
        const res = await page.goto(x.url, { waitUntil: "domcontentloaded" }).catch(() => null);
        await recorder.settle();
        const landed = new URL(page.url()).pathname;
        if ((LOGIN_RE.test(landed) && !LOGIN_RE.test(new URL(x.url).pathname)) || res?.status() === 401)
          throw new SessionExpired();
        try {
          ariaNow.set(x.instance!, await page.locator("body").ariaSnapshot({ timeout: 3000 }));
        } catch {}
      }
      // Reads the pages did not trigger again: ask for them directly with the same session.
      const seen = new Set(recorder.exchanges.map((e) => e.url.replace(/([?&])_=\d+/, "$1")));
      let n = 0;
      for (const x of apis) {
        if (seen.has(x.url.replace(/([?&])_=\d+/, "$1")) || n++ >= 200) continue;
        const headers: Record<string, string> = {};
        for (const [k, v] of x.reqHeaders) if (/^(accept|x-requested-with)$/i.test(k)) headers[k] = v;
        const r = await context.request.get(x.url, { headers, maxRedirects: 0, timeout: 15_000 }).catch(() => null);
        if (!r) continue;
        const body = await r.body().catch(() => Buffer.alloc(0));
        recorder.write({
          type: "exchange",
          id: `d${n}`,
          ts: Date.now(),
          endTs: Date.now(),
          method: "GET",
          url: x.url,
          reqHeaders: x.reqHeaders.filter(([k]) => !/cookie/i.test(k)),
          status: r.status(),
          resHeaders: r.headersArray().map((h) => [h.name, h.value]),
          resBody: recorder.bodies.put(body),
          resourceType: x.resourceType,
          causedBy: null,
        });
      }
    },
  });

  const now = loadCorpus(paths, config, [captureId]);
  const nowByInstance = new Map<string, Ex>();
  const nowByCluster = new Map<string, Ex[]>();
  for (const x of now.exchanges) {
    const r = resolveRequest(clusters, x.method, x.url, contentType(x.reqHeaders), x.reqText);
    x.cluster = r.cluster?.id;
    x.instance = instanceKey(r.parsed);
    nowByInstance.set(x.instance, x);
    if (x.cluster) nowByCluster.set(x.cluster, [...(nowByCluster.get(x.cluster) ?? []), x]);
  }

  const items: DriftItem[] = [];
  const add = (severity: Severity, area: DriftItem["area"], what: string, cluster?: Cluster, detail?: string) => {
    if (!items.some((i) => i.what === what && i.cluster === cluster?.id))
      items.push({ severity, area, what, cluster: cluster?.id, detail });
  };
  let probed = 0;

  // API and page structure, per recorded instance that was asked again.
  for (const [inst, old] of latest) {
    const c = classOf.get(old.cluster!)!;
    const cur = nowByInstance.get(inst);
    if (!cur) continue;
    probed++;
    if (c.class === "static") {
      if (cur.status >= 400)
        add("breaking", "assets", `Asset no longer served: ${new URL(old.url).pathname} (${cur.status})`, c);
      else if (cur.resBody && old.resBody && cur.resBody !== old.resBody)
        add("behavioural", "assets", `Asset changed: ${new URL(old.url).pathname}`, c);
      continue;
    }
    if (cur.status !== old.status) {
      add(
        cur.status >= 400 ? "breaking" : "behavioural",
        "api",
        `${c.key} now answers ${cur.status} (was ${old.status})`,
        c,
      );
      continue;
    }
    const ct = contentType(old.resHeaders);
    if (!isTextType(ct) || !old.resBody || !cur.resBody) continue;
    const a = old.bodies.text(old.resBody);
    const b = cur.bodies.text(cur.resBody);
    if (/json/.test(ct)) {
      try {
        const sa = shape(JSON.parse(a));
        const sb = shape(JSON.parse(b));
        for (const k of Object.keys(sa)) {
          if (!(k in sb)) add("breaking", "api", `${c.key}: field removed: ${k || "(root)"}`, c);
          else if (sa[k] !== sb[k] && sa[k] !== "null" && sb[k] !== "null")
            add("breaking", "api", `${c.key}: field ${k || "(root)"} changed type from ${sa[k]} to ${sb[k]}`, c);
        }
        for (const k of Object.keys(sb)) if (!(k in sa)) add("behavioural", "api", `${c.key}: new field: ${k}`, c);
      } catch {
        add("behavioural", "api", `${c.key}: response is no longer valid JSON`, c);
      }
      continue;
    }
    if (/html/.test(ct)) {
      const d = diffSets(htmlStructure(a), htmlStructure(b));
      for (const r of d.removed) add("breaking", "api", `${c.key}: form element removed: ${r}`, c);
      for (const r of d.added) add("behavioural", "api", `${c.key}: new form element: ${r}`, c);
      const rules = {
        jsonPaths: [],
        textContexts: [...(volatile[c.id]?.textContexts ?? []), ...(volatile["*"]?.textContexts ?? [])],
        headers: [],
      };
      const tagsOnly = (s: string) =>
        normalizeBody(ct, s, rules)
          .split("\n")
          .filter((l) => l.startsWith("<"))
          .map((l) => l.replace(/\d+/g, "0").replace(/(href|value|content|src|action|data-[\w-]+)="[^"]*"/g, '$1=""'))
          .join("\n");
      if (!d.removed.length && !d.added.length && tagsOnly(a) !== tagsOnly(b))
        add("cosmetic", "ui", `${c.key}: page markup changed`, c);
    }
  }

  // New script or style files the pages now load.
  const knownAssets = new Set(
    corpus.exchanges
      .filter((x) => classOf.get(x.cluster ?? "")?.class === "static")
      .map((x) => new URL(x.url).pathname),
  );
  for (const x of now.exchanges) {
    if (!x.inScope || !["script", "stylesheet"].includes(x.resourceType)) continue;
    const p = new URL(x.url).pathname;
    if (!knownAssets.has(p))
      add(
        "behavioural",
        "assets",
        `New ${x.resourceType} file: ${p}`,
        undefined,
        "The front-end was rebuilt; re-capture to refresh the copy.",
      );
  }

  // UI: controls an agent would look for. Compared per endpoint, not per page, because which controls a page shows
  // depends on its data (a patient with no notes has no "Delete note" button): a control is gone only when no
  // visited page of that endpoint shows it any more, and new only when no recorded page of it ever did.
  const before = new Map<string, Set<string>>();
  for (const s of corpus.snapshots) {
    const f = s.files.find((x) => x.endsWith(".aria.txt"));
    if (!f || !existsSync(join(s.dir, f))) continue;
    let c: Cluster | undefined;
    try {
      c = resolveRequest(clusters, "GET", s.url, "", "").cluster;
    } catch {}
    if (!c) continue;
    const set = before.get(c.id) ?? new Set<string>();
    for (const k of controlsOf(readFileSync(join(s.dir, f), "utf8"))) set.add(k);
    before.set(c.id, set);
  }
  const after = new Map<string, Set<string>>();
  for (const x of visit) {
    const aria = ariaNow.get(x.instance!);
    if (!aria) continue;
    const set = after.get(x.cluster!) ?? new Set<string>();
    for (const k of controlsOf(aria)) set.add(k);
    after.set(x.cluster!, set);
  }
  for (const [id, now_] of after) {
    const was = before.get(id);
    if (!was) continue;
    const c = classOf.get(id)!;
    const d = diffSets(was, now_);
    for (const r of d.removed) add("breaking", "ui", `${c.pathTemplate}: control gone or renamed: ${r}`, c);
    for (const r of d.added) add("behavioural", "ui", `${c.pathTemplate}: new control: ${r}`, c);
  }

  const order: Severity[] = ["breaking", "behavioural", "cosmetic"];
  items.sort((p, q) => order.indexOf(p.severity) - order.indexOf(q.severity));
  const report: DriftReport = {
    app: config.app,
    checkedAt: new Date().toISOString(),
    baseline: [...new Set(corpus.exchanges.map((x) => x.capture))],
    capture: captureId,
    probed,
    items,
    worst: items[0]?.severity ?? "none",
    affectedClusters: [...new Set(items.map((i) => i.cluster).filter((c): c is string => !!c))],
  };
  ensureDir(paths.drift);
  writeJson(join(paths.drift, "drift.json"), report);
  writeFileSync(join(paths.drift, "drift-report.md"), driftMarkdown(report));
  return report;
}

export function driftMarkdown(r: DriftReport): string {
  const lines = [
    `# Drift report: ${r.app}`,
    "",
    `Checked ${r.checkedAt}. Compared ${r.probed} recorded requests with the live app.`,
    "",
  ];
  if (!r.items.length) lines.push("No drift found.");
  for (const sev of ["breaking", "behavioural", "cosmetic"] as const) {
    const list = r.items.filter((i) => i.severity === sev);
    if (!list.length) continue;
    lines.push(`## ${sev[0]!.toUpperCase()}${sev.slice(1)} (${list.length})`, "");
    for (const i of list) lines.push(`- [${i.area}] ${i.what}${i.detail ? ` ${i.detail}` : ""}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** Make the drift capture part of the recordings, so analyze and build see the app as it is now. */
export function adoptDriftCapture(paths: AppPaths, captureId: string) {
  const file = join(paths.captures, captureId, "manifest.json");
  const m = readJson<Manifest>(file);
  m.mode = "script";
  m.label = "adopted from a drift check";
  writeJson(file, m);
}

/** Write a daily job definition. Returns the file and the command that turns it on. */
export function scheduleDaily(cwd: string, app: string, cli: string, hour = 6): { file: string; enable: string } {
  if (process.platform === "darwin") {
    const label = `com.thousand.sandbox.drift.${app.replace(/[^a-z0-9]/gi, "-")}`;
    const file = join(ensureDir(join(homedir(), "Library", "LaunchAgents")), `${label}.plist`);
    writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${cli}</string><string>drift</string><string>--app</string><string>${app}</string><string>--headless</string></array>
  <key>WorkingDirectory</key><string>${cwd}</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${join(cwd, ".sandbox", app, "drift", "schedule.log")}</string>
  <key>StandardErrorPath</key><string>${join(cwd, ".sandbox", app, "drift", "schedule.log")}</string>
</dict></plist>
`,
    );
    return { file, enable: `launchctl load ${file}` };
  }
  const file = join(ensureDir(join(cwd, ".sandbox", app, "drift")), "cron.txt");
  const line = `0 ${hour} * * * cd ${cwd} && ${process.execPath} ${cli} drift --app ${app} --headless >> ${join(cwd, ".sandbox", app, "drift", "schedule.log")} 2>&1`;
  writeFileSync(file, `${line}\n`);
  return { file, enable: `(crontab -l 2>/dev/null; cat ${file}) | crontab -` };
}
