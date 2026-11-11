import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
// @ts-expect-error plain JS fixture
import { startTinyClinic } from "../../../fixtures/tiny-clinic/server.mjs";
import { capture } from "../src/capture/index.js";
import { initApp } from "../src/init.js";

export interface Clinic {
  port: number;
  url: string;
  state(): {
    patients: { id: number; first: string; last: string; phone: string; signed: boolean }[];
    notes: { id: number; patient: number; text: string }[];
  };
  reset(): void;
  setVariant(v: "v1" | "v2"): void;
  dropSessions(): void;
  close(): Promise<void>;
}
export const startClinic = (port = 0) => startTinyClinic(port) as Promise<Clinic>;

export async function login(page: Page) {
  await page.fill("input[name=user]", "dr.test");
  await page.fill("input[name=password]", "test-password");
  await page.click("button[type=submit]");
  await page.waitForURL("**/patients");
}

/** A scripted session that reads several patients and makes each kind of write. */
export async function clinicSession(page: Page) {
  await login(page);
  for (const id of [101, 102, 103, 104]) {
    await page.goto(new URL(`/patients/${id}`, page.url()).href);
    await page.waitForSelector("#notes li");
    if (id === 101) await page.waitForTimeout(900); // linger like a person, so a settled snapshot is taken
  }
  await page.goto(new URL("/patients/102", page.url()).href);
  await page.waitForSelector("#notes li");
  await page.fill("#add-note input[name=text]", "Recorded by the capture script.");
  await page.click("#add-note button");
  await page.waitForFunction(() => document.querySelectorAll("#notes li[data-id]").length === 2);
  await page.click("#notes li:last-child .del");
  await page.waitForFunction(() => document.querySelectorAll("#notes li[data-id]").length === 1);
  await page.click("text=Edit demographics");
  await page.fill("input[name=phone]", "555-0199");
  await page.click("text=Save changes");
  await page.waitForURL("**/patients/102");
  await page.waitForSelector("#notes li");
  await page.goto(new URL("/search", page.url()).href);
  await page.fill("#search input[name=q]", "ta");
  await page.click("#search button");
  await page.waitForSelector("#results li");
  await page.goto(new URL("/patients", page.url()).href);
}

export async function captureClinic(
  clinic: Clinic,
  mode: "script" | "explore" = "script",
  extra: Partial<Parameters<typeof capture>[2]> = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "sbx-"));
  const { paths, config } = initApp(`${clinic.url}/`, { cwd, app: "tiny-clinic" });
  const id = await capture(paths, config, {
    mode,
    headless: true,
    bundledBrowser: true,
    script: mode === "script" ? clinicSession : undefined,
    ...extra,
  });
  return { cwd, paths, config, id };
}
