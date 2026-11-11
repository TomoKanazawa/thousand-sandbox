import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { capture } from "../src/capture/index.js";
import { listCaptures } from "../src/util.js";
import { verify } from "../src/verify/index.js";
import { type Clinic, captureClinic, clinicSession, startClinic } from "./helpers.js";

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "../../../fixtures/tiny-clinic/replica");

/** A test system is often put back to its starting data between recordings. The same session recorded twice
 *  then expects the same new ids both times, which one continuous timeline cannot give. */
describe("a second capture on a system that was reset", () => {
  let clinic: Clinic;
  let ctx: Awaited<ReturnType<typeof captureClinic>>;

  beforeAll(async () => {
    clinic = await startClinic();
    ctx = await captureClinic(clinic);
    cpSync(FIXTURE, ctx.paths.replica, { recursive: true });
  });
  afterAll(() => clinic.close());

  const again = (afterReset: boolean) => {
    clinic.reset();
    clinic.dropSessions(); // a restart also logs everyone out, so the session script logs in again
    return capture(ctx.paths, ctx.config, {
      mode: "script",
      headless: true,
      bundledBrowser: true,
      script: clinicSession,
      afterReset,
    });
  };

  it("fails the check when the tool is not told", async () => {
    const id = await again(false);
    analyze(ctx.paths, ctx.config);
    const r = await verify(ctx.paths, ctx.config, { write: false });
    expect(r.failures.length).toBeGreaterThan(0);
    rmSync(join(ctx.paths.captures, id), { recursive: true });
  });

  it("passes when the capture is marked as recorded after a reset", async () => {
    await again(true);
    expect(listCaptures(ctx.paths)).toHaveLength(2);
    analyze(ctx.paths, ctx.config);
    const r = await verify(ctx.paths, ctx.config, { write: false });
    expect(r.failures).toEqual([]);
    expect(r.checked).toBeGreaterThan(30);
  });
});
