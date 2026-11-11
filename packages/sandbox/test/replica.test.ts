import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { type RunningSandbox, up } from "../src/runtime/server.js";
import { verify } from "../src/verify/index.js";
import { type Clinic, captureClinic, startClinic } from "./helpers.js";

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "../../../fixtures/tiny-clinic/replica");

describe("a stateful copy of tiny-clinic", () => {
  let clinic: Clinic;
  let ctx: Awaited<ReturnType<typeof captureClinic>>;
  let sandbox: RunningSandbox;
  let browser: Browser;

  beforeAll(async () => {
    clinic = await startClinic();
    ctx = await captureClinic(clinic);
    analyze(ctx.paths, ctx.config);
    cpSync(FIXTURE, ctx.paths.replica, { recursive: true });
    await clinic.close();
  });
  afterAll(async () => {
    await browser?.close();
    await sandbox?.stop();
  });

  it("passes L1, L2 and L3 and labels the endpoints verified", async () => {
    const r = await verify(ctx.paths, ctx.config);
    expect(r.failures).toEqual([]);
    expect(r.checked).toBeGreaterThan(15);
    const by = (method: string, path: string) =>
      r.ledger.clusters.find((c) => c.key.startsWith(`${method} `) && c.key.endsWith(` ${path}`))!;
    expect(by("GET", "/patients/{id}").label).toBe("verified");
    expect(by("GET", "/patients/{id}").checks.l2[0]).toBeGreaterThan(0);
    expect(by("GET", "/api/patients/{id}/notes").checks.l3[0]).toBeGreaterThan(0);
    expect(by("GET", "/api/patients/{id}/notes").label).toBe("verified");
    expect(by("POST", "/login").label).toBe("replayed-only");
    expect(r.ledger.actions.some((a) => a.name.includes("Add note"))).toBe(true);
  });

  it("catches a handler that returns wrong data", async () => {
    const r = await verify(ctx.paths, ctx.config, { write: false });
    expect(r.passed).toBe(r.checked);
    const { writeFileSync, readFileSync, renameSync, rmSync } = await import("node:fs");
    const file = join(ctx.paths.replica, "routes", "notes-list.ts");
    const wrong = join(ctx.paths.replica, "routes", "notes-list-wrong.ts"); // a new name: the test runner caches modules by path
    writeFileSync(wrong, readFileSync(file, "utf8").replace("order by id", "order by id desc"));
    renameSync(file, `${file}.off`);
    const bad = await verify(ctx.paths, ctx.config, { write: false });
    expect(bad.failures.length).toBeGreaterThan(0);
    expect(
      bad.ledger.clusters.find((c) => c.key.endsWith("/api/patients/{id}/notes") && c.key.startsWith("GET"))?.label,
    ).toBe("inferred");
    rmSync(wrong);
    renameSync(`${file}.off`, file);
  });

  it("keeps writes, lets an agent read the state, and resets", async () => {
    sandbox = await up(ctx.paths, ctx.config);
    browser = await chromium.launch({ args: sandbox.chromeArgs });
    const page = await browser.newPage();
    await page.goto(`${clinic.url}/patients/104`);
    await page.waitForSelector("#notes li");
    expect(await page.locator("#notes li[data-id]").count()).toBe(0);
    await page.fill("#add-note input[name=text]", "Written inside the copy.");
    await page.click("#add-note button");
    await page.waitForSelector("#notes li[data-id]");
    await page.reload();
    await page.waitForSelector("#notes li[data-id]");
    expect(await page.locator("#notes li span").first().textContent()).toBe("Written inside the copy.");

    const state = (await (await fetch(`${sandbox.controlUrl}/state`)).json()) as {
      note: { patient: number; text: string }[];
    };
    expect(state.note.some((n) => n.patient === 104 && n.text === "Written inside the copy.")).toBe(true);

    // Patient 104 was only ever read in the capture; editing it works because the handler is real code.
    await page.click("text=Edit demographics");
    await page.fill("input[name=phone]", "555-0000");
    await page.click("text=Save changes");
    await page.waitForURL("**/patients/104");
    expect(await page.locator("#phone").textContent()).toBe("555-0000");

    await fetch(`${sandbox.controlUrl}/reset`, { method: "POST" });
    await page.reload();
    await page.waitForSelector("#notes li");
    expect(await page.locator("#notes li[data-id]").count()).toBe(0);
    expect(await page.locator("#phone").textContent()).toBe("555-0104");

    // "Sign and send chart" was never recorded: the copy says so instead of guessing.
    const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/sign")), page.click("#sign")]);
    expect(res.status()).toBe(501);
    const log = (await (await fetch(`${sandbox.controlUrl}/log`)).json()) as { served: string }[];
    expect(log.some((l) => l.served === "uncaptured")).toBe(true);
  });
});
