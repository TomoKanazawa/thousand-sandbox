import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { judgeClick, judgeRequest } from "../src/capture/gate.js";
import { loadPolicy } from "../src/capture/index.js";
import { scrubCapture } from "../src/scrub/index.js";
import { BodyStore, readEvents } from "../src/util.js";
import { type Clinic, captureClinic, login, startClinic } from "./helpers.js";

describe("write gates", () => {
  it("UI gate refuses commit controls and lets navigation through", () => {
    expect(judgeClick({ tag: "button", name: "Sign and send chart" })).toBeTruthy();
    expect(judgeClick({ tag: "button", name: "Delete note" })).toBeTruthy();
    expect(
      judgeClick({ tag: "button", name: "Add note", isSubmit: true, inForm: true, formMethod: "get" }),
    ).toBeTruthy();
    expect(judgeClick({ tag: "a", name: "Log out", href: "http://x/logout" })).toBeTruthy();
    expect(judgeClick({ tag: "button", name: "Save changes", isSubmit: true, formMethod: "post" })).toBeTruthy();
    expect(judgeClick({ tag: "a", name: "Marlow, Ada", href: "http://x/patients/101" })).toBeNull();
    expect(judgeClick({ tag: "button", name: "Search", isSubmit: true, formMethod: "post" })).toBeNull();
    expect(judgeClick({ tag: "a", name: "Edit demographics", href: "http://x/patients/101/edit" })).toBeNull();
    expect(judgeClick({ tag: "button", name: "Delete note" }, { allowWrites: true })).toBeNull();
    expect(judgeClick({ tag: "a", name: "Log out" }, { allowWrites: true })).toBeTruthy();
  });

  it("network gate blocks unknown writes, allows known reads, and respects the user's policy", () => {
    const req = (method: string, url: string, body = "") => ({ method, url, contentType: "application/json", body });
    expect(judgeRequest(req("GET", "http://x/patients/1"), "k", {}).allow).toBe(true);
    expect(judgeRequest(req("GET", "http://x/notes/delete/1"), "k", {}).allow).toBe(false);
    expect(judgeRequest(req("GET", "http://x/do.jsp?action=delete&id=1"), "k", {}).allow).toBe(false);
    expect(judgeRequest(req("POST", "http://x/api/notes", '{"text":"a"}'), "k", {}).allow).toBe(false);
    expect(judgeRequest(req("POST", "http://x/api/search", '{"q":"a"}'), "k", {}).allow).toBe(true);
    expect(judgeRequest(req("POST", "http://x/graphql", '{"query":"query Q { a }"}'), "k", {}).allow).toBe(true);
    expect(judgeRequest(req("POST", "http://x/graphql", '{"query":"mutation M { a }"}'), "k", {}).allow).toBe(false);
    expect(judgeRequest(req("DELETE", "http://x/api/notes/1"), "k", {}).allow).toBe(false);
    expect(
      judgeRequest(req("POST", "http://x/api/notes", "{}"), "k", { k: { decision: "read", by: "user" } }).allow,
    ).toBe(true);
    expect(
      judgeRequest(req("POST", "http://x/api/search", "{}"), "k", { k: { decision: "write", by: "user" } }).allow,
    ).toBe(false);
  });
});

describe("unattended exploration of tiny-clinic", () => {
  let clinic: Clinic;
  let ctx: Awaited<ReturnType<typeof captureClinic>>;
  let before: string;

  beforeAll(async () => {
    clinic = await startClinic();
    // Log in once (as the user does with `sandbox init`), then explore with the saved session.
    ctx = await captureClinic(clinic, "script", { script: login, probe: false });
    before = JSON.stringify(clinic.state());
    const { capture } = await import("../src/capture/index.js");
    await capture(ctx.paths, ctx.config, {
      mode: "explore",
      headless: true,
      bundledBrowser: true,
      maxActions: 60,
      startUrl: `${clinic.url}/patients`,
    });
  });
  afterAll(() => clinic.close());

  it("changes nothing in the live app", () => {
    expect(JSON.stringify(clinic.state())).toBe(before);
  });

  it("still reaches the pages and the POST search, and records what it refused", () => {
    const a = analyze(ctx.paths, ctx.config);
    const paths = a.clusters.map((c) => `${c.method} ${c.pathTemplate}`);
    expect(paths).toContain("GET /patients/{id}");
    expect(paths).toContain("GET /patients/{id}/edit");
    expect(paths).toContain("GET /api/patients/{id}/notes");
    expect(paths).toContain("POST /api/search");
    expect(paths).not.toContain("POST /api/patients/{id}/sign");
    expect(paths).not.toContain("DELETE /api/notes/{id}");
    const ids = [...new Set(a.clusters.flatMap((c) => c.exchangeIds.map((i) => i.split(":")[0]!)))];
    const notes = ids.flatMap((id) => readEvents(join(ctx.paths.captures, id))).filter((e) => e.type === "gate");
    expect(notes.some((n) => n.type === "gate" && /Sign and send chart/.test(n.text))).toBe(true);
    expect(notes.some((n) => n.type === "gate" && /Delete note/.test(n.text))).toBe(true);
    expect(loadPolicy(ctx.paths)[`POST ${new URL(clinic.url).host} /api/search`]?.decision).toBe("read");
  });
});

describe("personal data scrub", () => {
  it("replaces names, phones and birth dates consistently and keeps records joined", async () => {
    const clinic = await startClinic();
    const ctx = await captureClinic(clinic);
    await clinic.close();
    const r = await scrubCapture(ctx.paths, ctx.id, "pii");
    expect(r.pii).toBeGreaterThan(5);
    const dir = join(ctx.paths.captures, ctx.id, "scrubbed");
    const bodies = new BodyStore(join(dir, "bodies"));
    const texts = readEvents(dir).flatMap((e) => (e.type === "exchange" && e.resBody ? [bodies.text(e.resBody)] : []));
    const all = texts.join("\n");
    // Found through a labelled field somewhere (a form input, a JSON key, an element id), then replaced everywhere.
    for (const real of ["Okafor", "Tanaka", "555-0101", "555-0199", "1961-03-14"])
      expect(all, real).not.toContain(real);
    // Known limit: a name that only ever appears as free text is not found without a language model.
    // The review step lists it so a person can see it.
    expect(all).toContain("Marlow");
    const { reviewSample } = await import("../src/scrub/index.js");
    expect(reviewSample(ctx.paths, ctx.id, 200)).toContain("Marlow, Ada");
    // The fake last name of patient 103 is the same in the JSON search result and in the HTML pages.
    const search = texts.find((t) => t.startsWith("[{") && t.includes('"id":103') && !t.includes("dob"))!;
    const fakeLast = (JSON.parse(search) as { id: number; last: string }[]).find((p) => p.id === 103)!.last;
    expect(fakeLast).not.toBe("Tanaka");
    expect(texts.filter((t) => t.includes("<title>") && t.includes(fakeLast)).length).toBeGreaterThan(0);
    // Dates keep their format.
    expect(all).toMatch(/<dd id="dob">\d{4}-\d{2}-\d{2}<\/dd>/);
  });
});
