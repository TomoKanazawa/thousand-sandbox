import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { SessionExpired, controlsOf, drift } from "../src/drift/index.js";
import { type Clinic, captureClinic, startClinic } from "./helpers.js";

describe("drift check", () => {
  let clinic: Clinic;
  let ctx: Awaited<ReturnType<typeof captureClinic>>;

  beforeAll(async () => {
    clinic = await startClinic();
    ctx = await captureClinic(clinic);
    analyze(ctx.paths, ctx.config);
  });
  afterAll(() => clinic.close());

  it("reads controls from an accessibility snapshot", () => {
    const c = controlsOf(
      '- navigation:\n  - link "Patients"\n- list:\n  - link "Marlow, Ada"\n- button "Add note"\n- textbox "New note"',
    );
    expect([...c].sort()).toEqual(['button "Add note"', 'link "Patients"', 'textbox "New note"']);
  });

  it("reports nothing when only data changed", async () => {
    clinic.state().notes.push({ id: 99, patient: 101, text: "A new note is data, not drift." });
    const r = await drift(ctx.paths, ctx.config, { headless: true, bundledBrowser: true });
    expect(r.probed).toBeGreaterThan(5);
    expect(r.items.filter((i) => i.severity !== "cosmetic")).toEqual([]);
  });

  it("reports a renamed button and a removed API field as breaking", async () => {
    clinic.setVariant("v2");
    const r = await drift(ctx.paths, ctx.config, { headless: true, bundledBrowser: true });
    expect(r.worst).toBe("breaking");
    const what = r.items.map((i) => `${i.severity}: ${i.what}`).join("\n");
    expect(what).toMatch(/breaking: .*control gone or renamed: button "Add note"/);
    expect(what).toMatch(/behavioural: .*new control: button "Create note"/);
    expect(what).toMatch(/breaking: .*field removed: \[\]\.author/);
    expect(what).toMatch(/behavioural: .*new field: \[\]\.created/);
    expect(r.affectedClusters.length).toBeGreaterThan(0);
  });

  it("stops and says so when the session has expired", async () => {
    clinic.dropSessions();
    await expect(drift(ctx.paths, ctx.config, { headless: true, bundledBrowser: true })).rejects.toBeInstanceOf(
      SessionExpired,
    );
  });
});
