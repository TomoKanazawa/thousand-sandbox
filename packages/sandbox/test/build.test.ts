import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { type BuildState, build } from "../src/builder/index.js";
import { type AgentRunner, type RunRequest, allowTool } from "../src/builder/runner.js";
import { readJson } from "../src/util.js";
import { verify } from "../src/verify/index.js";
import { type Clinic, captureClinic, startClinic } from "./helpers.js";

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "../../../fixtures/tiny-clinic/replica");

/** Stands in for the coding agent: writes the fixture's files, with one deliberate mistake that needs a repair. */
class ScriptedRunner implements AgentRunner {
  calls: RunRequest[] = [];
  async run(req: RunRequest) {
    this.calls.push(req);
    const routes = join(req.writeDir, "routes");
    if (req.step === "model") {
      for (const f of ["schema.sql", "seed.sql"]) cpSync(join(FIXTURE, f), join(req.writeDir, f));
      cpSync(join(FIXTURE, "templates"), join(req.writeDir, "templates"), { recursive: true });
    } else if (req.prompt.includes("Step: repair")) {
      rmSync(join(routes, "notes-list-wrong.ts"), { force: true });
      cpSync(join(FIXTURE, "routes", "notes-list.ts"), join(routes, "notes-list.ts"));
    } else {
      // Every implement step: the fixture's routes, but the notes list sorted the wrong way until a repair happens.
      cpSync(join(FIXTURE, "routes"), routes, { recursive: true });
      if (!this.calls.some((c) => c.prompt.includes("Step: repair"))) {
        writeFileSync(
          join(routes, "notes-list-wrong.ts"),
          readFileSync(join(FIXTURE, "routes", "notes-list.ts"), "utf8").replace("order by id", "order by id desc"),
        );
        rmSync(join(routes, "notes-list.ts"));
      }
    }
    return { ok: true, costUsd: 0.25, sessionId: `s-${req.step}`, text: "done" };
  }
}

describe("build supervisor", () => {
  let clinic: Clinic;
  let ctx: Awaited<ReturnType<typeof captureClinic>>;

  beforeAll(async () => {
    clinic = await startClinic();
    ctx = await captureClinic(clinic);
    analyze(ctx.paths, ctx.config);
    await clinic.close();
  });

  it("gives the builder only the build set", async () => {
    const runner = new ScriptedRunner();
    const check = (clusters: string[] | undefined, write: boolean) =>
      verify(ctx.paths, ctx.config, { write, onlyClusters: clusters });
    const r = await build(ctx.paths, ctx.config, { runner, check, maxUsd: 20, parallel: 2 });
    const split = readJson<{ heldOut: string[] }>(join(ctx.paths.analysis, "split.json"));
    const timeline = readFileSync(join(ctx.paths.build, "input", "timeline.jsonl"), "utf8");
    expect(split.heldOut.length).toBeGreaterThan(0);
    for (const id of split.heldOut) expect(timeline).not.toContain(`"${id}"`);
    expect(runner.calls[0]!.denyDirs).toContain(ctx.paths.heldOut);

    // One endpoint was wrong on purpose: the verifier caught it and a repair step fixed it.
    expect(runner.calls.some((c) => c.prompt.includes("Step: repair"))).toBe(true);
    expect(r.stoppedBecause).toBe("done");
    expect(r.ledger.clusters.filter((c) => c.failures.length)).toEqual([]);
    expect(r.ledger.summary.verified).toBeGreaterThan(3);
    expect(r.costUsd).toBeCloseTo(runner.calls.length * 0.25);
    const state = readJson<BuildState>(join(ctx.paths.build, "state.json"));
    expect(state.steps.model?.done).toBe(true);
    expect(existsSync(join(ctx.paths.replica, "replica.json"))).toBe(true);
  });

  it("resumes without repeating finished steps, and stops at the budget", async () => {
    const runner = new ScriptedRunner();
    const check = (clusters: string[] | undefined, write: boolean) =>
      verify(ctx.paths, ctx.config, { write, onlyClusters: clusters });
    const r = await build(ctx.paths, ctx.config, { runner, check, resume: true, maxUsd: 20 });
    expect(runner.calls).toEqual([]);
    expect(r.stoppedBecause).toBe("done");

    const fresh = new ScriptedRunner();
    const stopped = await build(ctx.paths, ctx.config, { runner: fresh, check, maxUsd: 0.3 });
    expect(stopped.stoppedBecause).toBe("budget");
    expect(fresh.calls.length).toBeLessThanOrEqual(2);
  });

  it("keeps the agent inside its box", () => {
    const req = {
      cwd: ctx.paths.root,
      writeDir: ctx.paths.replica,
      readDirs: [join(ctx.paths.build, "input")],
      denyDirs: [ctx.paths.captures, ctx.paths.heldOut],
      checkCommand: "node /x/cli.js verify --app a --no-write --build-only",
    };
    expect(allowTool("Write", { file_path: join(ctx.paths.replica, "routes", "a.ts") }, req)).toBeNull();
    expect(allowTool("Write", { file_path: join(ctx.paths.root, "policy.yaml") }, req)).toBeTruthy();
    expect(allowTool("Read", { file_path: join(ctx.paths.build, "input", "clusters.json") }, req)).toBeNull();
    expect(allowTool("Read", { file_path: join(ctx.paths.heldOut, "ids.json") }, req)).toBeTruthy();
    expect(allowTool("Read", { file_path: join(ctx.paths.captures, "x", "bodies", "abc") }, req)).toBeTruthy();
    expect(allowTool("Read", { file_path: "/etc/passwd" }, req)).toBeTruthy();
    expect(allowTool("Grep", { pattern: "x", path: ctx.paths.captures }, req)).toBeTruthy();
    expect(
      allowTool("Bash", { command: "node /x/cli.js verify --app a --no-write --build-only --cluster c_0003" }, req),
    ).toBeNull();
    expect(allowTool("Bash", { command: "cat ../held-out/ids.json" }, req)).toBeTruthy();
    expect(
      allowTool("Bash", { command: "node /x/cli.js verify --app a --no-write --build-only; cat ../captures/x" }, req),
    ).toBeTruthy();
    expect(allowTool("WebFetch", { url: "https://example.com" }, req)).toBeTruthy();
  });
});
