import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Frame, Page, Request, WebSocket } from "playwright";
import type { ActionEvent, CaptureEvent, ExchangeEvent, Headers, SnapshotEvent } from "../types.js";
import { BodyStore, ensureDir } from "../util.js";
import { LISTENER_SCRIPT } from "./pagescript.js";

const SETTLE_QUIET_MS = 500;
const SETTLE_CAP_MS = 10_000;

/**
 * Records one episode: every HTTP exchange with bodies, WebSocket frames, user actions and page snapshots.
 * Works for the whole browser context, so pop-up windows and iframes are covered.
 */
export class Recorder {
  readonly bodies: BodyStore;
  private file: string;
  private t0 = Date.now();
  private seq = 0;
  private inflight = 0;
  private lastActivity = Date.now();
  private pending = new Set<Promise<unknown>>();
  private starts = new Map<Request, { id: string; ts: number; causedBy: string | null }>();
  private bodyOf = new Map<Request, Promise<Buffer | null>>();
  private currentAction: { id: string; until: number } | null = null;
  private lastSnapshot: string | undefined;
  private gen = 0;
  private closed = false;
  source: ActionEvent["source"] = "human";
  readonly exchanges: ExchangeEvent[] = [];
  readonly actions: ActionEvent[] = [];
  screenshots = false;

  constructor(
    private context: BrowserContext,
    private dir: string,
    episode: number,
  ) {
    this.bodies = new BodyStore(join(dir, "bodies"));
    ensureDir(join(dir, "episodes"));
    ensureDir(join(dir, "snapshots"));
    this.file = join(dir, "episodes", `${episode}.jsonl`);
    writeFileSync(this.file, "");
  }

  private now() {
    return Date.now() - this.t0;
  }
  private nextId(prefix: string) {
    return `${prefix}${++this.seq}`;
  }
  write(ev: CaptureEvent) {
    if (ev.type === "exchange") this.exchanges.push(ev);
    if (ev.type === "action") this.actions.push(ev);
    appendFileSync(this.file, `${JSON.stringify(ev)}\n`);
  }
  note(type: "console" | "dialog" | "popup" | "download" | "gate", text: string) {
    this.write({ type, id: this.nextId("n"), ts: this.now(), text });
  }

  private track<T>(p: Promise<T>) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => {});
  }

  private cause(): string | null {
    return this.currentAction && Date.now() <= this.currentAction.until ? this.currentAction.id : null;
  }

  async start() {
    const ctx = this.context;
    await ctx.exposeBinding("__sbxEvent", (src, payload: string) => this.onPageEvent(src.page, src.frame, payload));
    await ctx.addInitScript(LISTENER_SCRIPT);

    ctx.on("request", (req) => {
      this.inflight++;
      this.lastActivity = Date.now();
      this.starts.set(req, { id: this.nextId("x"), ts: this.now(), causedBy: this.cause() });
    });
    // Ask for the body the moment the response starts: once the page navigates away, the browser drops it.
    ctx.on("response", (res) => {
      const status = res.status();
      if ((status >= 300 && status < 400) || status === 204) return;
      const p = res.body().catch(() => null);
      this.bodyOf.set(res.request(), p);
      this.track(p);
    });
    ctx.on("requestfinished", (req) => this.track(this.finish(req)));
    ctx.on("requestfailed", (req) => this.track(this.finish(req, req.failure()?.errorText ?? "failed")));
    ctx.on("page", (page) => this.attachPage(page, true));
    for (const page of ctx.pages()) this.attachPage(page, false);
  }

  private attachPage(page: Page, isNew: boolean) {
    if (isNew)
      page
        .opener()
        .then((o) => o && this.note("popup", page.url()))
        .catch(() => {});
    page.on("console", (m) => m.type() === "error" && this.note("console", m.text().slice(0, 500)));
    page.on("dialog", (d) => {
      this.note("dialog", `${d.type()}: ${d.message().slice(0, 300)}`);
      if (this.source !== "human") d.dismiss().catch(() => {});
    });
    page.on("download", (d) => this.note("download", d.suggestedFilename()));
    page.on("websocket", (ws) => this.attachSocket(ws));
    // A snapshot as soon as the page has loaded, in case the next navigation comes before the network is quiet;
    // a second, better one once it has settled.
    page.on("load", () => {
      this.track(this.snapshot(page, "load", this.cause() ?? undefined));
      this.scheduleSnapshot(page, undefined);
    });
  }

  private attachSocket(ws: WebSocket) {
    const socket = this.nextId("s");
    const emit = (direction: "sent" | "received" | "open" | "close", payload?: string | Buffer) =>
      this.write({
        type: "ws",
        id: this.nextId("w"),
        ts: this.now(),
        socket,
        url: ws.url(),
        direction,
        payload: typeof payload === "string" ? payload : payload ? payload.toString("base64") : undefined,
        binary: payload !== undefined && typeof payload !== "string" ? true : undefined,
        causedBy: this.cause(),
      });
    emit("open");
    ws.on("framesent", (f) => emit("sent", f.payload));
    ws.on("framereceived", (f) => emit("received", f.payload));
    ws.on("close", () => !this.closed && emit("close"));
  }

  private async finish(req: Request, failed?: string) {
    const start = this.starts.get(req);
    this.starts.delete(req);
    this.inflight = Math.max(0, this.inflight - 1);
    this.lastActivity = Date.now();
    if (!start) return;
    const url = req.url();
    if (!/^https?:/.test(url)) return;
    let status = 0;
    let resHeaders: Headers = [];
    let resBody: string | undefined;
    let reqHeaders: Headers = [];
    try {
      reqHeaders = (await req.headersArray()).map((h) => [h.name, h.value]);
    } catch {
      reqHeaders = Object.entries(req.headers());
    }
    try {
      const res = await req.response();
      if (res) {
        status = res.status();
        resHeaders = (await res.headersArray()).map((h) => [h.name, h.value]);
        const early = await this.bodyOf.get(req);
        this.bodyOf.delete(req);
        if (early) resBody = this.bodies.put(early);
        else if (!failed && (status < 300 || status >= 400) && status !== 204) {
          try {
            resBody = this.bodies.put(await res.body());
          } catch {}
        }
      }
    } catch {}
    const post = req.postDataBuffer();
    this.write({
      type: "exchange",
      id: start.id,
      ts: start.ts,
      endTs: this.now(),
      method: req.method(),
      url,
      reqHeaders,
      reqBody: post ? this.bodies.put(post) : undefined,
      status,
      resHeaders,
      resBody,
      resourceType: req.resourceType(),
      causedBy: start.causedBy,
      failed,
    });
  }

  /** Record a request the network gate stopped. */
  blocked(req: Request, reason: string) {
    const post = req.postDataBuffer();
    this.write({
      type: "exchange",
      id: this.nextId("x"),
      ts: this.now(),
      endTs: this.now(),
      method: req.method(),
      url: req.url(),
      reqHeaders: Object.entries(req.headers()),
      reqBody: post ? this.bodies.put(post) : undefined,
      status: 0,
      resHeaders: [],
      resourceType: req.resourceType(),
      causedBy: this.cause(),
      blocked: true,
      failed: reason,
    });
  }

  private onPageEvent(page: Page | null, frame: Frame | null, payload: string) {
    if (!page || this.closed) return;
    let data: { kind: ActionEvent["kind"]; target: ActionEvent["target"]; value?: string; frameUrl?: string };
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    const ev: ActionEvent = {
      type: "action",
      id: this.nextId("a"),
      ts: this.now(),
      kind: data.kind,
      target: data.target,
      value: data.value,
      source: this.source,
      pageUrl: page.url(),
      frameUrl: frame && frame !== page.mainFrame() ? data.frameUrl : undefined,
      snapshotBefore: this.lastSnapshot,
    };
    this.currentAction = { id: ev.id, until: Date.now() + SETTLE_CAP_MS };
    this.write(ev);
    this.scheduleSnapshot(page, ev.id);
  }

  /** Mark an action made by a script or crawler that the page listener cannot see (for example a navigation). */
  markAction(page: Page, kind: ActionEvent["kind"], name: string, value?: string): string {
    const ev: ActionEvent = {
      type: "action",
      id: this.nextId("a"),
      ts: this.now(),
      kind,
      target: { tag: "", name },
      value,
      source: this.source,
      pageUrl: page.url(),
      snapshotBefore: this.lastSnapshot,
    };
    this.currentAction = { id: ev.id, until: Date.now() + SETTLE_CAP_MS };
    this.write(ev);
    return ev.id;
  }

  private scheduleSnapshot(page: Page, after: string | undefined) {
    const owner = after ?? this.cause() ?? undefined;
    const gen = ++this.gen;
    this.track(this.settleAndSnapshot(page, "settled", owner, gen));
  }

  /** Wait until the network has been quiet, capped. Returns false when `stale` says the wait no longer matters. */
  async settle(stale?: () => boolean): Promise<boolean> {
    const deadline = Date.now() + SETTLE_CAP_MS;
    while (Date.now() < deadline) {
      if (stale?.()) return false;
      const quietFor = Date.now() - this.lastActivity;
      if (this.inflight === 0 && quietFor >= SETTLE_QUIET_MS) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return !stale?.();
  }

  private async settleAndSnapshot(page: Page, reason: SnapshotEvent["reason"], after: string | undefined, gen: number) {
    // A newer action or page load takes over: a late snapshot would show the wrong screen.
    if (!(await this.settle(() => this.gen !== gen || this.closed))) return;
    await this.snapshot(page, reason, after);
    if (after && this.currentAction?.id === after) this.currentAction.until = Date.now();
  }

  async snapshot(page: Page, reason: SnapshotEvent["reason"], after?: string): Promise<string | undefined> {
    if (this.closed || page.isClosed()) return undefined;
    const id = this.nextId("p");
    const files: string[] = [];
    try {
      const html = await page.content();
      writeFileSync(join(this.dir, "snapshots", `${id}.html`), html);
      files.push(`${id}.html`);
      const aria = await page.locator("body").ariaSnapshot({ timeout: 3000 });
      writeFileSync(join(this.dir, "snapshots", `${id}.aria.txt`), aria);
      files.push(`${id}.aria.txt`);
      if (this.screenshots) {
        await page.screenshot({ path: join(this.dir, "snapshots", `${id}.png`) });
        files.push(`${id}.png`);
      }
    } catch {
      if (!files.length) return undefined;
    }
    let title = "";
    try {
      title = await page.title();
    } catch {}
    this.write({ type: "snapshot", id, ts: this.now(), reason, url: page.url(), title, files, after });
    this.lastSnapshot = id;
    return id;
  }

  /** Wait for in-flight bodies and snapshots to be written. */
  async flush() {
    await this.settle();
    for (let i = 0; i < 20 && this.pending.size; i++) await Promise.allSettled([...this.pending]);
  }

  async stop() {
    await this.flush();
    this.closed = true;
  }
}
