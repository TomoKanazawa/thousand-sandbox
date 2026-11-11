import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, type Page, chromium } from "playwright";
import YAML from "yaml";
import { parseRequest } from "../analyze/cluster.js";
import { scrubCapture } from "../scrub/index.js";
import type { AppConfig, ExchangeEvent, Manifest, Policy } from "../types.js";
import { type AppPaths, TOOL_VERSION, contentType, ensureDir, log, writeJson } from "../util.js";
import { explore } from "./explore.js";
import { guessFromShape, judgeRequest } from "./gate.js";
import { Recorder } from "./recorder.js";

export interface CaptureOptions {
  mode: "human" | "explore" | "script";
  headless?: boolean;
  /** Use the bundled Chromium instead of installed Chrome (tests, CI). */
  bundledBrowser?: boolean;
  allowWrites?: boolean;
  maxActions?: number;
  probe?: boolean;
  screenshots?: boolean;
  label?: string;
  startUrl?: string;
  /** Script mode: drive the page yourself. */
  script?: (page: Page, helpers: { recorder: Recorder; context: BrowserContext }) => Promise<void>;
  /** Stop writes at the network even outside exploration (drift checks). */
  gate?: boolean;
  /** Stored in the manifest instead of `mode` (drift checks are kept out of the build corpus). */
  manifestMode?: Manifest["mode"];
  /** Human mode: resolves when the user is done. Default: the browser window is closed. */
  until?: (context: BrowserContext) => Promise<void>;
}

export async function launchBrowser(
  paths: AppPaths,
  opts: { headless?: boolean; bundledBrowser?: boolean; harPath?: string },
) {
  const context = await launchContext(paths, opts);
  // Chrome forgets session cookies (no expiry date) when it closes, and many apps log in with exactly those.
  // Keep them next to the profile so unattended runs (explore, drift) start logged in.
  const file = join(paths.root, "session-cookies.json");
  if (existsSync(file)) {
    try {
      await context.addCookies(JSON.parse(readFileSync(file, "utf8")));
    } catch {}
  }
  const save = async () => {
    try {
      const cookies = (await context.cookies()).filter((c) => c.expires === -1);
      writeFileSync(file, JSON.stringify(cookies), { mode: 0o600 });
    } catch {}
  };
  const timer = setInterval(save, 2000);
  context.on("close", () => clearInterval(timer));
  const close = context.close.bind(context);
  context.close = async (...args: Parameters<typeof close>) => {
    await save();
    clearInterval(timer);
    return close(...args);
  };
  return context;
}

async function launchContext(
  paths: AppPaths,
  opts: { headless?: boolean; bundledBrowser?: boolean; harPath?: string },
) {
  ensureDir(paths.profile);
  const common = {
    headless: opts.headless ?? false,
    serviceWorkers: "block" as const,
    viewport: { width: 1366, height: 900 },
    recordHar: opts.harPath ? { path: opts.harPath, content: "embed" as const } : undefined,
  };
  if (!opts.bundledBrowser) {
    try {
      return await chromium.launchPersistentContext(paths.profile, { ...common, channel: "chrome" });
    } catch (e) {
      log(`Installed Chrome not usable (${(e as Error).message.split("\n")[0]}); using bundled Chromium.`);
    }
  }
  return chromium.launchPersistentContext(paths.profile, common);
}

export function loadPolicy(paths: AppPaths): Policy {
  const file = join(paths.root, "policy.yaml");
  return existsSync(file) ? ((YAML.parse(readFileSync(file, "utf8")) as Policy) ?? {}) : {};
}

export function savePolicy(paths: AppPaths, policy: Policy) {
  const sorted = Object.fromEntries(Object.entries(policy).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    join(paths.root, "policy.yaml"),
    `# Read/write decision per endpoint. Edit "decision" (read | write | unknown) and set by: user to make it stick.\n${YAML.stringify(sorted)}`,
  );
}

export function newCaptureId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

/** Record one capture of the live app. Returns the capture id. */
export async function capture(paths: AppPaths, config: AppConfig, opts: CaptureOptions): Promise<string> {
  const id = newCaptureId();
  const dir = ensureDir(join(paths.captures, id));
  ensureDir(join(dir, "har"));
  const startUrl = opts.startUrl ?? config.startUrl;
  const policy = loadPolicy(paths);
  const gated = opts.mode === "explore" || opts.gate === true;
  const allowWrites = opts.allowWrites ?? !gated;

  const context = await launchBrowser(paths, {
    headless: opts.headless,
    bundledBrowser: opts.bundledBrowser,
    harPath: join(dir, "har", "1.har"),
  });
  const manifest: Manifest = {
    toolVersion: TOOL_VERSION,
    id,
    origins: config.origins,
    startUrl,
    startedAt: new Date().toISOString(),
    browser: context.browser()?.version(),
    viewport: { width: 1366, height: 900 },
    mode: opts.manifestMode ?? opts.mode,
    allowWrites,
    episodes: 1,
    scrub: "none",
    label: opts.label,
  };
  writeJson(join(dir, "manifest.json"), manifest);

  const recorder = new Recorder(context, dir, 1);
  recorder.source = opts.mode === "human" ? "human" : opts.mode === "explore" ? "agent" : "script";
  recorder.screenshots = opts.screenshots ?? false;

  // Network gate. In human mode it only observes; in exploration it blocks anything that is not known to be a read.
  if (gated) {
    await context.route("**/*", async (route) => {
      const req = route.request();
      const body = req.postData() ?? "";
      const ct = req.headers()["content-type"] ?? "";
      let key = "";
      try {
        key = parseRequest(req.method(), req.url(), ct, body).key;
      } catch {
        return route.continue();
      }
      const inScope = config.origins.includes(new URL(req.url()).origin);
      const verdict = inScope
        ? judgeRequest({ method: req.method(), url: req.url(), contentType: ct, body }, key, policy, { allowWrites })
        : { allow: true as const, reason: "out of scope" };
      if (!policy[key] && inScope && !["GET", "HEAD", "OPTIONS"].includes(req.method()))
        policy[key] = guessFromShape(req.method(), req.url(), ct, body);
      if (verdict.allow) return route.continue();
      recorder.blocked(req, verdict.reason);
      recorder.note("gate", `blocked ${req.method()} ${req.url()} (${verdict.reason})`);
      return route.abort("blockedbyclient");
    });
  }

  await recorder.start();
  const page = context.pages()[0] ?? (await context.newPage());
  let closedByUser = false;
  context.on("close", () => {
    closedByUser = true;
  });

  try {
    recorder.markAction(page, "navigate", startUrl);
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    await recorder.settle();
    await recorder.snapshot(page, "start");

    if (opts.mode === "script") {
      if (!opts.script) throw new Error("script mode needs a script");
      await opts.script(page, { recorder, context });
    } else if (opts.mode === "explore") {
      await explore(page, recorder, {
        origins: config.origins,
        maxActions: opts.maxActions ?? config.budgets.exploreActions,
        allowWrites,
      });
    } else {
      log("Recording. Use the app as usual, then close the browser window to finish.");
      await (opts.until ? opts.until(context) : new Promise<void>((resolve) => context.on("close", () => resolve())));
    }

    if (!closedByUser) {
      await recorder.flush();
      if (opts.probe !== false) await probePass(context, recorder, config.origins);
      const last = context.pages().find((p) => !p.isClosed());
      if (last) await recorder.snapshot(last, "end");
    }
  } catch (e) {
    // A session that failed part-way is not a capture: leave nothing half-written behind.
    await recorder.stop().catch(() => {});
    if (!closedByUser) await context.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    await recorder.stop().catch(() => {});
    if (!closedByUser) await context.close().catch(() => {});
  }

  // Remember what the gate learned, and what a human session showed.
  for (const x of recorder.exchanges) {
    if (["GET", "HEAD", "OPTIONS"].includes(x.method) || !config.origins.includes(safeOrigin(x.url))) continue;
    const body = recorder.bodies.text(x.reqBody);
    const key = parseRequest(x.method, x.url, contentType(x.reqHeaders), body).key;
    if (!policy[key]) policy[key] = guessFromShape(x.method, x.url, contentType(x.reqHeaders), body);
  }
  savePolicy(paths, policy);

  manifest.endedAt = new Date().toISOString();
  writeJson(join(dir, "manifest.json"), manifest);
  await scrubCapture(paths, id, config.scrub);
  return id;
}

const safeOrigin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/**
 * Probe pass: ask for every safe GET once more with the live session. Whatever differs between the first
 * answer and the probe, with no write in between, is volatile (timestamps, tokens).
 */
async function probePass(context: BrowserContext, recorder: Recorder, origins: string[], limit = 400) {
  const seen = new Set<string>();
  const targets: ExchangeEvent[] = [];
  for (const x of [...recorder.exchanges].reverse()) {
    if (x.method !== "GET" || x.status !== 200 || x.blocked || !origins.includes(safeOrigin(x.url))) continue;
    if (!["document", "xhr", "fetch"].includes(x.resourceType)) continue;
    if (/log-?out|sign-?out|logoff/i.test(x.url) || seen.has(x.url)) continue;
    seen.add(x.url);
    targets.push(x);
    if (targets.length >= limit) break;
  }
  let n = 0;
  for (const x of targets.reverse()) {
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of x.reqHeaders) if (/^(accept|x-requested-with|x-csrf.*|referer)$/i.test(k)) headers[k] = v;
      // Twice in a row: the two answers have no write between them for certain, so any difference is volatile.
      n++;
      for (const pass of ["a", "b"]) {
        const res = await context.request.get(x.url, { headers, maxRedirects: 0, timeout: 15_000 });
        const body = await res.body().catch(() => Buffer.alloc(0));
        recorder.write({
          type: "probe",
          id: `r${n}${pass}`,
          ts: Date.now(),
          of: x.id,
          status: res.status(),
          resHeaders: res.headersArray().map((h) => [h.name, h.value]),
          resBody: res.status() === 200 ? recorder.bodies.put(body) : undefined,
        });
      }
    } catch {}
  }
  log(`Probe pass: ${n} of ${targets.length} safe GETs repeated.`);
}
