import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { type RunningSandbox, up } from "../src/runtime/server.js";
import { readEvents } from "../src/util.js";
import { type Clinic, captureClinic, startClinic } from "./helpers.js";

describe("record, analyze and replay tiny-clinic", () => {
  let clinic: Clinic;
  let ctx: Awaited<ReturnType<typeof captureClinic>>;
  let sandbox: RunningSandbox;
  let browser: Browser;

  beforeAll(async () => {
    clinic = await startClinic();
    ctx = await captureClinic(clinic);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await sandbox?.stop();
    await clinic?.close();
  });

  it("records exchanges, actions, snapshots and probes", () => {
    const events = readEvents(`${ctx.paths.captures}/${ctx.id}`);
    const kinds = new Set(events.map((e) => e.type));
    for (const k of ["exchange", "action", "snapshot", "probe", "ws"]) expect(kinds, k).toContain(k);
    const post = events.find((e) => e.type === "exchange" && e.method === "POST" && e.url.endsWith("/notes"));
    expect(post && post.type === "exchange" && post.causedBy).toBeTruthy();
  });

  it("removes the session cookie, token and password from the scrubbed copy", () => {
    const raw = JSON.stringify(readEvents(`${ctx.paths.captures}/${ctx.id}`));
    const sid = /sid=([0-9a-f]{24})/.exec(raw)?.[1];
    expect(sid).toBeTruthy();
    const clean = JSON.stringify(readEvents(`${ctx.paths.captures}/${ctx.id}/scrubbed`));
    expect(clean).not.toContain(sid);
    expect(clean).toContain("SBX_SESSION_1");
  });

  it("clusters endpoints and classifies them", () => {
    const a = analyze(ctx.paths, ctx.config);
    const by = (k: string) => a.clusters.find((c) => c.key.endsWith(k));
    expect(by("GET " + new URL(clinic.url).host + " /patients/{id}")?.class).toBe("read");
    expect(by("/patients/{id}")?.instances).toBe(4);
    expect(by("/api/patients/{id}/notes")).toBeTruthy();
    expect(a.clusters.find((c) => c.method === "POST" && c.pathTemplate === "/api/patients/{id}/notes")?.class).toBe(
      "write",
    );
    expect(a.clusters.find((c) => c.method === "DELETE")?.class).toBe("write");
    expect(a.clusters.find((c) => c.pathTemplate === "/api/search")?.class).toBe("read");
    expect(a.clusters.find((c) => c.pathTemplate === "/login" && c.method === "POST")?.class).toBe("session");
    expect(a.clusters.find((c) => c.pathTemplate === "/beacon")?.class).toBe("noise");
    expect(a.clusters.find((c) => c.pathTemplate === "/app.js")?.class).toBe("static");
    const page = a.clusters.find((c) => c.method === "GET" && c.pathTemplate === "/patients/{id}")!;
    expect(a.volatile[page.id]?.textContexts.length).toBeGreaterThan(0);
    expect(a.split.heldOut.length).toBeGreaterThan(0);
    expect(a.split.l3.length).toBeGreaterThan(0);
    expect(a.codeEndpoints).toContain("/sign"); // the button the script never clicked
  });

  it("serves the copy at the original URLs with the live app switched off", async () => {
    await clinic.close();
    sandbox = await up(ctx.paths, ctx.config);
    browser = await chromium.launch({ args: sandbox.chromeArgs });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${clinic.url}/login`);
    await page.fill("input[name=user]", "anyone");
    await page.fill("input[name=password]", "anything");
    await page.click("button[type=submit]");
    await page.waitForURL("**/patients");
    expect(await page.locator("#patients li").count()).toBe(4);
    await page.click("text=Marlow, Ada");
    await page.waitForSelector("#notes li[data-id]");
    expect(await page.locator("#notes li[data-id]").count()).toBe(2);
    expect(await page.locator("#phone").textContent()).toBe("555-0101");
    // The copy shows the end of the capture: patient 102's phone was edited during it.
    await page.goto(`${clinic.url}/patients/102`);
    expect(await page.locator("#phone").textContent()).toBe("555-0199");
    expect(errors).toEqual([]);

    // HTTPS: the proxy presents a certificate from the local authority, which this browser instance alone trusts.
    const secure = await page.goto(`${clinic.url.replace("http:", "https:")}/patients/103`);
    expect(secure?.status()).toBe(200);
    expect(await page.locator("#dob").textContent()).toBe("1990-07-23");

    const res = await page.goto(`${clinic.url}/patients/999`);
    expect(res?.status()).toBe(501);
    expect(res?.headers()["x-sandbox"]).toBe("uncaptured");
    const log = (await (await fetch(`${sandbox.controlUrl}/log`)).json()) as { served: string }[];
    expect(log.some((l) => l.served === "replay")).toBe(true);
    expect(log.some((l) => l.served === "static")).toBe(true);
  }, 60_000);
});
