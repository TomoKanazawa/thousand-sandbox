import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { chromium } from "playwright";
import type { AppConfig } from "../types.js";
import { type AppPaths, ensureDir, log } from "../util.js";
import { Replica, type ReplicaOptions } from "./replica.js";

export interface RunningSandbox {
  replica: Replica;
  proxyPort: number;
  proxyUrl: string;
  controlPort: number;
  controlUrl: string;
  /** Chrome flags that make a browser use the copy at the app's original URLs. */
  chromeArgs: string[];
  /** DevTools address of the Chrome we launched, if any. Agents attach here. */
  cdpUrl?: string;
  startUrl: string;
  stop(): Promise<void>;
}

async function ensureCa(paths: AppPaths) {
  const mockttp = await import("mockttp");
  ensureDir(paths.ca);
  const keyFile = join(paths.ca, "ca.key");
  const certFile = join(paths.ca, "ca.pem");
  if (!existsSync(keyFile) || !existsSync(certFile)) {
    const ca = await mockttp.generateCACertificate({
      subject: { commonName: "Thousand Sandbox local CA", organizationName: "Thousand Sandbox (this machine only)" },
      bits: 2048,
    });
    writeFileSync(keyFile, ca.key, { mode: 0o600 });
    writeFileSync(certFile, ca.cert);
  }
  const key = readFileSync(keyFile, "utf8");
  const cert = readFileSync(certFile, "utf8");
  return { key, cert, spki: await mockttp.generateSPKIFingerprint(cert) };
}

export interface UpOptions extends ReplicaOptions {
  proxyPort?: number;
  controlPort?: number;
  /** Launch Chrome pointed at the copy and expose its DevTools port. */
  launchChrome?: boolean;
  cdpPort?: number;
  headless?: boolean;
  bundledBrowser?: boolean;
}

/** Start the copy: replica + intercepting proxy + control endpoints. */
export async function up(paths: AppPaths, config: AppConfig, opts: UpOptions = {}): Promise<RunningSandbox> {
  const replica = new Replica(paths, config, opts);
  await replica.load();
  for (const e of replica.routeErrors) log(`route not loaded: ${e}`);

  const mockttp = await import("mockttp");
  const ca = await ensureCa(paths);
  const proxy = mockttp.getLocal({ https: { key: ca.key, cert: ca.cert } });
  await proxy.start(opts.proxyPort ?? 0);
  await proxy.forAnyRequest().thenCallback(async (req) => {
    // The proxy library listens on every network interface; answer this machine only.
    const from = req.remoteIpAddress ?? "";
    if (from && !/^(127\.|::1$|::ffff:127\.)/.test(from))
      return { statusCode: 403, body: "sandbox: local connections only" };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers))
      if (v !== undefined)
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(k.toLowerCase() === "cookie" ? "; " : ", ") : v;
    const body = await req.body.getDecodedBuffer().catch(() => undefined);
    const res = await replica.handle({ method: req.method, url: req.url, headers, body: body ?? Buffer.alloc(0) });
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of res.headers) {
      const key = k.toLowerCase();
      if (key in out) out[key] = [...(Array.isArray(out[key]) ? (out[key] as string[]) : [out[key] as string]), v];
      else out[key] = v;
    }
    return { statusCode: res.status, headers: out, rawBody: res.body };
  });
  await proxy.forAnyWebSocket().thenRejectConnection(501, "sandbox: WebSocket replay is not built yet");

  let ready = false;
  const control = http.createServer((req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(value, null, 2));
    };
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/reset" && req.method === "POST") {
      replica.reset();
      return send(200, { ok: true });
    }
    if (path === "/state") return send(200, replica.state());
    if (path === "/log") return send(200, replica.log);
    if (path === "/ledger")
      return send(200, replica.ledger() ?? { error: "no ledger yet; run `sandbox build` or `sandbox verify`" });
    // ok turns true only once the proxy and (when launched) Chrome are ready, so a script can wait on it.
    if (path === "/health") return send(200, { ok: ready, app: config.app, endpoints: replica.clusters.length });
    send(404, {
      error: "unknown control endpoint",
      endpoints: ["POST /reset", "GET /state", "GET /log", "GET /ledger", "GET /health"],
    });
  });
  await new Promise<void>((r) => control.listen(opts.controlPort ?? 0, "127.0.0.1", () => r()));
  const controlPort = (control.address() as { port: number }).port;

  const chromeArgs = [
    `--proxy-server=127.0.0.1:${proxy.port}`,
    "--proxy-bypass-list=<-loopback>",
    `--ignore-certificate-errors-spki-list=${ca.spki}`,
    "--disable-quic",
    "--no-first-run",
    "--no-default-browser-check",
    // Keep Chrome's own background requests (updates, sign-in, safe browsing) out of the copy's log.
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--no-pings",
    "--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication",
  ];

  let chrome: ChildProcess | undefined;
  let cdpUrl: string | undefined;
  if (opts.launchChrome) {
    const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const exe = !opts.bundledBrowser && existsSync(macChrome) ? macChrome : chromium.executablePath();
    const profile = join(ensureDir(paths.run), `chrome-${opts.copy ?? 0}`);
    rmSync(profile, { recursive: true, force: true });
    const cdpPort = opts.cdpPort ?? 9333;
    chrome = spawn(
      exe,
      [
        ...chromeArgs,
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${cdpPort}`,
        ...(opts.headless ? ["--headless=new"] : []),
        config.startUrl,
      ],
      { stdio: "ignore" },
    );
    cdpUrl = `http://127.0.0.1:${cdpPort}`;
    // Chrome needs a moment before its DevTools port answers.
    for (let i = 0; i < 100; i++) {
      if (
        await fetch(`${cdpUrl}/json/version`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  ready = true;

  writeFileSync(
    join(ensureDir(paths.run), "up.json"),
    JSON.stringify(
      { pid: process.pid, proxyPort: proxy.port, controlPort, cdpUrl, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  );

  return {
    replica,
    proxyPort: proxy.port,
    proxyUrl: `http://127.0.0.1:${proxy.port}`,
    controlPort,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    chromeArgs,
    cdpUrl,
    startUrl: config.startUrl,
    async stop() {
      chrome?.kill();
      await proxy.stop();
      control.closeAllConnections?.();
      await new Promise<void>((r) => control.close(() => r()));
      replica.close();
      rmSync(join(paths.run, "up.json"), { force: true });
    },
  };
}
