import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeSeed } from "../runtime/replica.js";
import type { AppConfig, Cluster, Ledger } from "../types.js";
import { type AppPaths, TOOL_VERSION, ensureDir, listCaptures, readJson, writeJson } from "../util.js";
import type { VerifyResult } from "../verify/index.js";
import { CONTRACT_MD, RUNTIME_DTS } from "./contract.js";
import { prepareInput } from "./input.js";
import { type AgentRunner, ClaudeRunner, type RunRequest } from "./runner.js";

export interface BuildOptions {
  maxUsd?: number;
  resume?: boolean;
  /** Build only these endpoints (cluster ids). */
  clusters?: string[];
  parallel?: number;
  maxCycles?: number;
  runner?: AgentRunner;
  /** Runs the deterministic verifier. Default: a child process, so edited route files are always re-read. */
  check?: (clusters: string[] | undefined, write: boolean) => Promise<VerifyResult>;
  onProgress?: (line: string) => void;
}

interface StepState {
  done: boolean;
  ok?: boolean;
  costUsd: number;
  sessionId?: string;
  error?: string;
  attempts: number;
  /** The end of the agent's last message, kept to explain a step that produced nothing. */
  lastText?: string;
}
export interface BuildState {
  startedAt: string;
  updatedAt: string;
  costUsd: number;
  cycles: number;
  steps: Record<string, StepState>;
}

export interface BuildResult {
  state: BuildState;
  ledger: Ledger;
  costUsd: number;
  stoppedBecause: "done" | "budget" | "cycles";
}

const CLI = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.js");

function childCheck(paths: AppPaths, app: string, cwd: string) {
  return (clusters: string[] | undefined, write: boolean) =>
    new Promise<VerifyResult>((res, rej) => {
      const args = [
        CLI,
        "verify",
        "--app",
        app,
        "--json",
        ...(write ? [] : ["--no-write"]),
        ...(clusters?.length ? ["--cluster", clusters.join(",")] : []),
      ];
      execFile(process.execPath, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        try {
          res(JSON.parse(stdout) as VerifyResult);
        } catch {
          rej(new Error(`verify failed: ${stderr || err?.message || stdout.slice(0, 300)}`));
        }
      });
    });
}

const describeFailures = (r: VerifyResult, cluster?: string, limit = 6) => {
  const lines: string[] = [];
  for (const c of r.ledger.clusters) {
    if (cluster && c.cluster !== cluster) continue;
    for (const f of c.failures) {
      if (lines.length >= limit) break;
      // Differences on held-back exchanges are described without the expected content.
      lines.push(
        f.level === "l1"
          ? `- ${c.key} exchange ${f.exchange}: ${f.diff}`
          : `- ${c.key}: wrong on a ${f.level === "l2" ? "record you were not shown (the handler does not generalise)" : "read that follows a write (the write did not change the data the way the server does)"}${f.diff.startsWith("status") ? `; ${f.diff}` : ""}`,
      );
    }
  }
  return lines.join("\n");
};

/**
 * Generate the stateful copy. A supervisor runs one model call per step, saves state after each, and lets
 * only deterministic code judge the result.
 */
export async function build(paths: AppPaths, config: AppConfig, opts: BuildOptions = {}): Promise<BuildResult> {
  if (!existsSync(join(paths.analysis, "clusters.json"))) throw new Error("Run `sandbox analyze` first.");
  const cwd = resolve(paths.root, "..", "..");
  const runner = opts.runner ?? new ClaudeRunner();
  const check = opts.check ?? childCheck(paths, config.app, cwd);
  const say = opts.onProgress ?? (() => {});
  const maxUsd = opts.maxUsd ?? config.budgets.buildUsd;
  const stateFile = join(ensureDir(paths.build), "state.json");
  const state: BuildState =
    opts.resume && existsSync(stateFile)
      ? readJson<BuildState>(stateFile)
      : { startedAt: new Date().toISOString(), updatedAt: "", costUsd: 0, cycles: 0, steps: {} };
  const save = () => {
    state.updatedAt = new Date().toISOString();
    writeJson(stateFile, state);
  };

  const { dir: inputDir, targets: allTargets } = prepareInput(paths, config);
  const targets = opts.clusters?.length ? allTargets.filter((c) => opts.clusters!.includes(c.id)) : allTargets;
  ensureDir(join(paths.replica, "routes"));
  ensureDir(join(paths.replica, "templates"));
  writeFileSync(join(paths.replica, "runtime.d.ts"), RUNTIME_DTS);
  writeFileSync(join(paths.replica, "CONTRACT.md"), CONTRACT_MD);

  const checkCommand = `node ${CLI} verify --app ${config.app} --no-write --build-only`;
  const base: Omit<RunRequest, "step" | "prompt" | "model" | "maxUsd" | "maxTurns" | "resume"> = {
    cwd: paths.root,
    writeDir: paths.replica,
    readDirs: [inputDir],
    denyDirs: [paths.captures, paths.heldOut, paths.profile, join(paths.root, "pseudonyms.json")],
    checkCommand,
  };
  const remaining = () => maxUsd - state.costUsd;

  /** One model call for one step, recorded in state. Returns false when the budget is spent. */
  const step = async (
    name: string,
    model: string,
    prompt: string,
    share: number,
    maxTurns: number,
  ): Promise<boolean> => {
    const s = (state.steps[name] ??= { done: false, costUsd: 0, attempts: 0 });
    if (remaining() < 0.05) return false;
    s.attempts++;
    say(`${name}: started (attempt ${s.attempts})`);
    try {
      const r = await runner.run({
        ...base,
        step: name,
        prompt,
        model,
        maxUsd: Math.max(0.05, Math.min(remaining(), share)),
        maxTurns,
        resume: s.sessionId,
      });
      s.costUsd += r.costUsd;
      state.costUsd += r.costUsd;
      s.sessionId = r.sessionId ?? s.sessionId;
      s.ok = r.ok;
      s.error = r.error;
      s.lastText = r.text.slice(-600);
    } catch (e) {
      s.ok = false;
      s.error = (e as Error).message;
      save();
      throw e;
    }
    save();
    say(`${name}: ${s.ok ? "finished" : `stopped (${s.error})`}, $${s.costUsd.toFixed(2)}`);
    return true;
  };

  const intro = `You are building the backend of a local copy of a web app from recordings of the real one.
Read ${inputDir}/CONTRACT.md first; it defines the files, the rules and the inputs. Work only under ${paths.replica}.
To check your work run exactly: ${checkCommand}`;

  // ---- model: schema and seed ----
  if (!state.steps.model?.done) {
    const ok = await step(
      "model",
      config.models.model,
      `${intro}

Step: data model. Read input/clusters.json, input/timeline.jsonl, input/flow.json and the samples of the read
and write endpoints. Then write:
1. replica/schema.sql: tables for every entity the endpoints show or change.
2. replica/seed.sql: every record visible in the samples, as it was at the start of the earliest capture
   (undo the recorded writes: a record created during the session is not in the seed; an edited field has its
   earlier value where an earlier read shows it).
3. replica/MODEL.md: one line per read or write endpoint: cluster id, tables, and which request value selects the record.
Do not write route files in this step.`,
      maxUsd * 0.2,
      80,
    );
    if (!ok) return finish("budget");
    let seedError = "";
    try {
      if (!materializeSeed(paths)) seedError = "replica/schema.sql is missing";
    } catch (e) {
      seedError = (e as Error).message;
    }
    if (seedError) {
      await step(
        "model",
        config.models.model,
        `Loading replica/schema.sql and replica/seed.sql into SQLite failed: ${seedError}\nFix the files.`,
        maxUsd * 0.05,
        30,
      );
      materializeSeed(paths); // throws if still broken: the build cannot go on without a database
    }
    state.steps.model!.done = true;
    save();
  }

  // ---- implement: one handler per endpoint, a few at a time ----
  const implementPrompt = (c: Cluster) => `${intro} --cluster ${c.id}

Step: implement one endpoint.
Endpoint ${c.id}: ${c.key} (class ${c.class}, ${c.count} recorded exchanges, ${c.instances} distinct instances).
Read replica/MODEL.md, replica/schema.sql and input/samples/${c.id}/. Write replica/routes/${c.id}.ts.
Put HTML or JSON shapes shared with other endpoints in replica/templates/ and reuse what is already there.
If the data model lacks something this endpoint needs, extend schema.sql and seed.sql without breaking other endpoints.
Run the check, read the differences, fix, and repeat until this endpoint passes.`;

  /** True when some route file claims this endpoint, by cluster id or by its path. */
  const hasRoute = (c: Cluster) => {
    const dir = join(paths.replica, "routes");
    if (!existsSync(dir)) return false;
    const path = c.key.split(" ").pop() ?? "";
    return readdirSync(dir).some((f) => {
      if (!/\.(ts|js|mjs)$/.test(f)) return false;
      if (f.startsWith(`${c.id}.`)) return true;
      const text = readFileSync(join(dir, f), "utf8");
      return text.includes(`"${c.id}"`) || text.includes(`"${path}"`);
    });
  };
  const pending = targets.filter((c) => !state.steps[`implement:${c.id}`]?.done);
  const share = pending.length ? Math.max(0.5, (maxUsd * 0.6) / pending.length) : 0;
  let outOfBudget = false;
  const queue = [...pending];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const name = `implement:${c.id}`;
      if (!(await step(name, config.models.implement, implementPrompt(c), share, 60))) {
        outOfBudget = true;
        return;
      }
      // The agent can end "ok" without writing the handler. Ask once more, then leave the step open.
      if (!hasRoute(c) && state.steps[name]!.ok) {
        say(`${name}: no handler was written; asking again`);
        const again = `${implementPrompt(c)}

Your last turn ended without the file replica/routes/${c.id}.ts. Write that file now. Do not leave this endpoint to replay.`;
        if (!(await step(name, config.models.implement, again, share, 60))) {
          outOfBudget = true;
          return;
        }
      }
      state.steps[name]!.done = true;
      if (!hasRoute(c)) say(`${name}: still no handler; this endpoint stays on replay`);
      save();
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.parallel ?? 4, 4, Math.max(1, queue.length)) }, worker));
  if (outOfBudget) return finish("budget");

  // ---- verify, then repair what fails ----
  const maxCycles = opts.maxCycles ?? 8;
  let result = await check(undefined, true);
  while (result.failures.length && state.cycles < maxCycles) {
    if (remaining() < 0.05) return finish("budget", result);
    state.cycles++;
    const failing = result.ledger.clusters.filter(
      (c) => c.failures.length && (!opts.clusters?.length || opts.clusters.includes(c.cluster)),
    );
    if (!failing.length) break;
    say(`repair cycle ${state.cycles}: ${failing.length} endpoints fail`);
    const repairShare = Math.max(0.3, remaining() / (failing.length * Math.max(1, maxCycles - state.cycles + 1)));
    for (const c of failing) {
      const ok = await step(
        `implement:${c.cluster}`,
        config.models.triage,
        `${intro} --cluster ${c.cluster}

Step: repair. Endpoint ${c.cluster} (${c.key}) fails the checker:
${describeFailures(result, c.cluster)}
Find the cause in replica/routes, replica/templates, schema.sql or seed.sql and fix it. The cause may be in another
endpoint's write handler or in the seed data. Re-run the check until it passes.`,
        repairShare,
        50,
      );
      if (!ok) return finish("budget", result);
    }
    result = await check(undefined, true);
  }
  return finish(result.failures.length ? "cycles" : "done", result);

  async function finish(stoppedBecause: BuildResult["stoppedBecause"], last?: VerifyResult): Promise<BuildResult> {
    const final = last ?? (await check(undefined, true));
    save();
    writeJson(join(paths.replica, "replica.json"), {
      toolVersion: TOOL_VERSION,
      app: config.app,
      origins: config.origins,
      captures: listCaptures(paths),
      models: config.models,
      buildCostUsd: Number(state.costUsd.toFixed(4)),
      builtAt: new Date().toISOString(),
      stoppedBecause,
    });
    return { state, ledger: final.ledger, costUsd: state.costUsd, stoppedBecause };
  }
}

/** What a build is likely to cost, from the number of endpoints. A rough guide printed before any model call. */
export function estimateBuild(paths: AppPaths): { endpoints: number; lowUsd: number; highUsd: number } {
  const clusters = JSON.parse(readFileSync(join(paths.analysis, "clusters.json"), "utf8")) as Cluster[];
  const endpoints = clusters.filter((c) => c.class === "read" || c.class === "write").length;
  return { endpoints, lowUsd: Math.round(2 + endpoints * 0.3), highUsd: Math.round(5 + endpoints * 1.2) };
}
