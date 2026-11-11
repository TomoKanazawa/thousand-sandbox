#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { analyze } from "./analyze/index.js";
import { build, estimateBuild } from "./builder/index.js";
import { type CaptureOptions, capture, launchBrowser, loadPolicy, savePolicy } from "./capture/index.js";
import { SessionExpired, adoptDriftCapture, drift, scheduleDaily } from "./drift/index.js";
import { initApp } from "./init.js";
import { up } from "./runtime/server.js";
import { reviewSample, scrubCapture } from "./scrub/index.js";
import type { Ledger, Manifest } from "./types.js";
import { TOOL_VERSION, appPaths, listCaptures, loadConfig, readJson, resolveApp, writeJson } from "./util.js";
import { reportMarkdown, verify } from "./verify/index.js";

const CLI = fileURLToPath(import.meta.url);

// A .env file in the working directory may hold ANTHROPIC_API_KEY. Variables already set win.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // An unreadable .env is ignored; `sandbox doctor` reports a missing key.
  }
}
const out = (s: string) => process.stdout.write(`${s}\n`);

function ctx(opts: { app?: string }) {
  const app = resolveApp(opts.app);
  const paths = appPaths(app);
  return { app, paths, config: loadConfig(paths) };
}

const program = new Command();
program
  .name("sandbox")
  .description("An exact working copy of any web app, as a sandbox for testing AI agents.")
  .version(TOOL_VERSION);
const withApp = (c: Command) =>
  c.option("--app <name>", "which app under .sandbox/ (needed only when there are several)");

withApp(program.command("init <url>").description("Set up a new app and open Chrome so you can log in once"))
  .option("--origin <origin...>", "extra origins the copy should answer for (default: the URL's origin)")
  .option("--no-login", "do not open the browser now")
  .action(async (url: string, o: { app?: string; origin?: string[]; login: boolean }) => {
    const u = new URL(url);
    const { paths, config } = initApp(url, { app: o.app, origins: o.origin ? [u.origin, ...o.origin] : undefined });
    out(`Created ${paths.root}`);
    if (o.login) await openForLogin(paths, config.startUrl);
    out("Next: sandbox capture");
  });

withApp(program.command("login").description("Open Chrome with the saved profile to log in again")).action(
  async (o) => {
    const { paths, config } = ctx(o);
    await openForLogin(paths, config.startUrl);
  },
);

async function openForLogin(paths: ReturnType<typeof appPaths>, url: string) {
  out(
    "A Chrome window is opening. Log in, then close the window. The session is kept in a profile used only by this tool.",
  );
  const context = await launchBrowser(paths, {});
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url).catch(() => {});
  await new Promise<void>((r) => context.on("close", () => r()));
}

withApp(program.command("capture").description("Record the live app"))
  .option("--human", "you use the app; everything is recorded (default)")
  .option("--explore", "automatic read-only crawl; writes are blocked")
  .option(
    "--script <file>",
    "run this session instead of a person: a module whose default export is async (page) => {}",
  )
  .option("--allow-writes", "with --explore: let writes through (only for apps you own that reset)")
  .option("--max-actions <n>", "with --explore: stop after this many actions", (v) => Number.parseInt(v, 10))
  .option("--headless", "no visible window (not for --human)")
  .option("--screenshots", "also save a screenshot with each snapshot")
  .option("--label <text>", "a note stored with the capture")
  .action(async (o) => {
    const { paths, config } = ctx(o);
    if (o.script && o.explore) throw new Error("Use --script or --explore, not both.");
    let script: CaptureOptions["script"];
    if (o.script) {
      const mod = await import(pathToFileURL(resolve(String(o.script))).href);
      if (typeof mod.default !== "function")
        throw new Error(`${o.script} must have a default export: async (page, { context }) => { ... }`);
      script = mod.default;
    }
    const id = await capture(paths, config, {
      mode: o.script ? "script" : o.explore ? "explore" : "human",
      script,
      allowWrites: o.explore ? !!o.allowWrites : true,
      maxActions: o.maxActions,
      headless: !!o.headless,
      screenshots: !!o.screenshots,
      label: o.label,
    });
    const a = analyze(paths, config);
    out(`Capture ${id} saved. ${a.coverage.exchanges} exchanges in ${a.coverage.clusters} endpoints so far.`);
    out("Next: sandbox up (replay as recorded), or sandbox build (make it stateful).");
  });

withApp(program.command("policy").description("Show or change which endpoints are reads and which are writes"))
  .option("--set <key=decision...>", 'for example --set "POST example.com /api/search=read"')
  .action((o) => {
    const { paths } = ctx(o);
    const policy = loadPolicy(paths);
    for (const s of (o.set as string[] | undefined) ?? []) {
      const i = s.lastIndexOf("=");
      const decision = s.slice(i + 1);
      if (!["read", "write", "unknown"].includes(decision))
        throw new Error(`Decision must be read, write or unknown: ${s}`);
      policy[s.slice(0, i)] = { decision: decision as "read" | "write" | "unknown", by: "user" };
    }
    if (o.set) savePolicy(paths, policy);
    for (const [k, v] of Object.entries(policy))
      out(`${v.decision.padEnd(8)} ${v.by.padEnd(10)} ${k}${v.note ? `  (${v.note})` : ""}`);
    if (!Object.keys(policy).length) out("No decisions yet. They are added as requests other than GET are seen.");
    out(`\nFile: ${join(paths.root, "policy.yaml")}`);
  });

withApp(program.command("scrub").description("Remove secrets (and optionally personal data) from the captures"))
  .option("--pii", "also replace personal data with consistent fakes")
  .option("--off", "only strip secrets (for apps with fictional data)")
  .option("--review", "show what was replaced and what still looks personal")
  .option("--confirm", "mark the review as done, which allows a build on personal data")
  .action(async (o) => {
    const { paths, config } = ctx(o);
    const mode = o.pii ? "pii" : o.off ? "secrets" : config.scrub;
    for (const id of listCaptures(paths)) {
      const r = await scrubCapture(paths, id, mode);
      out(`${id}: ${r.secrets} secrets, ${r.pii} personal values, ${r.replacements} replacements`);
      if (o.review) {
        out("  Replaced with (sample):");
        for (const s of r.samples) out(`    ${s.kind}: ${s.fake}`);
        out("  Still present and looks like a name or date (check these):");
        for (const s of reviewSample(paths, id)) out(`    ${s}`);
      }
      if (o.confirm) {
        const file = join(paths.captures, id, "manifest.json");
        writeJson(file, { ...readJson<Manifest>(file), reviewed: true });
      }
    }
    if (mode === "pii") out("Automated de-identification is not a guarantee. Keep captures on this machine.");
  });

withApp(program.command("analyze").description("Group requests into endpoints and classify them (no model)")).action(
  (o) => {
    const { paths, config } = ctx(o);
    const a = analyze(paths, config);
    out(
      `Endpoints: ${a.coverage.clusters}  (static ${a.coverage.static ?? 0}, read ${a.coverage.read ?? 0}, write ${a.coverage.write ?? 0}, session ${a.coverage.session ?? 0}, noise ${a.coverage.noise ?? 0})`,
    );
    out(
      `Exchanges: ${a.coverage.exchanges}; kept back for checking: ${a.split.heldOut.length}; read-after-write checks: ${a.split.l3.length}`,
    );
    if (a.codeEndpoints.length)
      out(
        `Named in the app's code but never seen (${a.codeEndpoints.length}): ${a.codeEndpoints.slice(0, 8).join(", ")}${a.codeEndpoints.length > 8 ? ", ..." : ""}`,
      );
    out(`Files: ${paths.analysis}`);
  },
);

withApp(program.command("build").description("Generate the stateful copy with a coding agent, then check it"))
  .option("--max-usd <x>", "stop when this much has been spent", Number.parseFloat)
  .option("--resume", "continue an interrupted build")
  .option("--cluster <ids>", "only these endpoints, comma-separated")
  .option("--yes", "do not ask before spending")
  .action(async (o) => {
    const { paths, config } = ctx(o);
    for (const id of listCaptures(paths)) {
      const m = readJson<Manifest>(join(paths.captures, id, "manifest.json"));
      if (m.phi && !m.reviewed)
        throw new Error(
          `Capture ${id} holds personal data and has not been reviewed. Run: sandbox scrub --review, then sandbox scrub --confirm`,
        );
    }
    analyze(paths, config);
    const est = estimateBuild(paths);
    const cap = o.maxUsd ?? config.budgets.buildUsd;
    out(
      `${est.endpoints} endpoints to build. Rough cost $${est.lowUsd}-${est.highUsd}; hard stop at $${cap}. Uses your ANTHROPIC_API_KEY.`,
    );
    if (!o.yes && process.stdin.isTTY) {
      process.stdout.write("Start? [y/N] ");
      const answer = await new Promise<string>((r) => process.stdin.once("data", (d) => r(String(d).trim())));
      process.stdin.pause();
      if (!/^y/i.test(answer)) return;
    }
    const r = await build(paths, config, {
      maxUsd: cap,
      resume: !!o.resume,
      clusters: o.cluster ? String(o.cluster).split(",") : undefined,
      onProgress: (l) => out(`  ${l}`),
    });
    out(
      `Build ${r.stoppedBecause === "done" ? "finished" : `stopped (${r.stoppedBecause})`}. Spent about $${r.costUsd.toFixed(2)} (the SDK's estimate, not a bill).`,
    );
    out(summaryLine(r.ledger));
  });

const summaryLine = (l: Ledger) =>
  `Endpoints: ${Object.entries(l.summary)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")}`;

withApp(program.command("verify").description("Check the copy against the recordings (no model)"))
  .option("--json", "print the full result as JSON")
  .option("--no-write", "do not update ledger.json")
  .option("--cluster <ids>", "only report these endpoints, comma-separated")
  .option("--build-only", "hide expected content of held-back exchanges (what the builder sees)")
  .action(async (o) => {
    const { paths, config } = ctx(o);
    const r = await verify(paths, config, {
      write: o.write,
      onlyClusters: o.cluster ? String(o.cluster).split(",") : undefined,
      buildOnly: !!o.buildOnly,
    });
    if (o.json) {
      out(JSON.stringify(r));
      return;
    }
    out(`${r.passed}/${r.checked} checks pass. ${summaryLine(r.ledger)}`);
    for (const c of r.ledger.clusters)
      for (const f of c.failures.slice(0, 3)) out(`FAIL ${c.cluster} ${c.key} [${f.level}] ${f.exchange}: ${f.diff}`);
    if (r.failures.length) process.exitCode = 1;
  });

withApp(program.command("report").description("Ledger and coverage as Markdown")).action(async (o) => {
  const { paths, config } = ctx(o);
  const ledgerFile = join(paths.replica, "ledger.json");
  const ledger = existsSync(ledgerFile) ? readJson<Ledger>(ledgerFile) : (await verify(paths, config)).ledger;
  const coverageFile = join(paths.analysis, "coverage.json");
  const md = reportMarkdown(ledger, existsSync(coverageFile) ? readJson(coverageFile) : undefined);
  writeFileSync(join(paths.replica, "report.md"), md);
  out(md);
});

withApp(program.command("up").description("Run the copy; any browser agent can use it at the app's original URLs"))
  .option("--port <p>", "proxy port", (v) => Number.parseInt(v, 10), 8877)
  .option("--control-port <p>", "port for /reset, /state, /log, /ledger", (v) => Number.parseInt(v, 10), 8878)
  .option("--cdp-port <p>", "DevTools port of the Chrome we launch", (v) => Number.parseInt(v, 10), 9333)
  .option("--no-chrome", "do not launch Chrome; print the flags instead")
  .option("--headless", "launch Chrome without a window")
  .option("--today", "use the real clock instead of continuing from the capture time")
  .option("--replay-only", "ignore generated handlers; answer only from recordings")
  .action(async (o) => {
    const { paths, config } = ctx(o);
    if (!existsSync(join(paths.analysis, "clusters.json"))) analyze(paths, config);
    const s = await up(paths, config, {
      proxyPort: o.port,
      controlPort: o.controlPort,
      cdpPort: o.cdpPort,
      launchChrome: o.chrome,
      headless: !!o.headless,
      clock: o.today ? "today" : "capture",
      replayOnly: !!o.replayOnly,
    });
    out(`The copy of ${config.app} is running.`);
    out(`  App URL (unchanged):  ${config.startUrl}`);
    if (s.cdpUrl) out(`  Attach your agent to: ${s.cdpUrl}   (Chrome DevTools address)`);
    else out(`  Start Chrome with:    ${s.chromeArgs.join(" ")} --user-data-dir=<empty dir>`);
    out(`  Control:              POST ${s.controlUrl}/reset   GET ${s.controlUrl}/state | /log | /ledger`);
    out("Press Ctrl-C to stop.");
    const stop = async () => {
      await s.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

const running = (paths: ReturnType<typeof appPaths>) => {
  const file = join(paths.run, "up.json");
  if (!existsSync(file)) throw new Error("The copy is not running. Start it with: sandbox up");
  return readJson<{ pid: number; controlPort: number }>(file);
};

withApp(program.command("reset").description("Restore the copy's data to the seed")).action(async (o) => {
  const { paths } = ctx(o);
  const r = await fetch(`http://127.0.0.1:${running(paths).controlPort}/reset`, { method: "POST" });
  out(r.ok ? "Reset." : `Reset failed: ${r.status}`);
});

withApp(program.command("down").description("Stop the running copy")).action((o) => {
  const { paths } = ctx(o);
  process.kill(running(paths).pid, "SIGTERM");
  out("Stopped.");
});

withApp(program.command("drift").description("Re-check the live app and report what changed"))
  .option("--headless", "no visible window")
  .option("--update", "take the new recording into the copy and rebuild the affected endpoints")
  .option("--max-usd <x>", "with --update: spending cap for the rebuild", Number.parseFloat)
  .action(async (o) => {
    const { paths, config } = ctx(o);
    try {
      const r = await drift(paths, config, { headless: !!o.headless });
      out(readFileSync(join(paths.drift, "drift-report.md"), "utf8"));
      if (o.update && r.items.length) {
        adoptDriftCapture(paths, r.capture);
        analyze(paths, config);
        const hasRoutes = existsSync(join(paths.replica, "routes"));
        if (hasRoutes && r.affectedClusters.length) {
          const b = await build(paths, config, {
            maxUsd: o.maxUsd,
            resume: true,
            clusters: r.affectedClusters,
            onProgress: (l) => out(`  ${l}`),
          });
          out(
            `Rebuilt ${r.affectedClusters.length} endpoints for about $${b.costUsd.toFixed(2)}. ${summaryLine(b.ledger)}`,
          );
        } else out("The copy now replays the new recording.");
      }
      process.exitCode = r.worst === "breaking" ? 2 : r.worst === "none" ? 0 : 1;
    } catch (e) {
      if (!(e instanceof SessionExpired)) throw e;
      out(e.message);
      process.exitCode = 3;
    }
  });

withApp(program.command("schedule <when>").description("Run the drift check every day (when: daily)"))
  .option("--hour <h>", "hour of the day, 0-23", (v) => Number.parseInt(v, 10), 6)
  .action((when: string, o) => {
    if (when !== "daily") throw new Error("Only `daily` is supported.");
    const { app } = ctx(o);
    const s = scheduleDaily(process.cwd(), app, CLI, o.hour);
    out(`Wrote ${s.file}\nTurn it on with:\n  ${s.enable}`);
    out("The check uses the saved login. When the app's session expires it stops and asks you to run `sandbox login`.");
  });

program
  .command("doctor")
  .description("Check that this machine can run the tool")
  .action(async () => {
    const ok = (good: boolean, label: string, hint = "") =>
      out(`${good ? "ok  " : "FAIL"} ${label}${good || !hint ? "" : `  -> ${hint}`}`);
    const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
    ok(major > 22 || (major === 22 && minor >= 13), `Node ${process.versions.node}`, "Node 22.13 or newer is needed");
    const chrome =
      process.platform === "darwin"
        ? existsSync("/Applications/Google Chrome.app")
        : ["google-chrome", "google-chrome-stable", "chromium"].some((b) => has(b));
    ok(chrome, "Google Chrome", "install Chrome, or run: npx playwright install chromium");
    ok(
      !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_USE_BEDROCK || !!process.env.CLAUDE_CODE_USE_VERTEX,
      "ANTHROPIC_API_KEY (needed for `sandbox build` only)",
      "export ANTHROPIC_API_KEY=...",
    );
    const sdk = await import("@anthropic-ai/claude-agent-sdk" as string).then(() => true).catch(() => false);
    ok(sdk, "Claude Agent SDK (needed for `sandbox build` only)", "npm install @anthropic-ai/claude-agent-sdk");
    ok(
      totalmem() >= 6 * 2 ** 30,
      `Memory ${(totalmem() / 2 ** 30).toFixed(0)} GB`,
      "builds run up to 4 agents at about 1 GB each",
    );
    try {
      const fs = statfsSync(process.cwd());
      const free = (fs.bavail * fs.bsize) / 2 ** 30;
      ok(free > 2, `Disk ${free.toFixed(0)} GB free`, "captures need a few GB");
    } catch {}
    ok(has("docker"), "Docker (optional)", "only needed to run copies in CI containers");
  });

function has(bin: string) {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

program.parseAsync().catch((e: Error) => {
  process.stderr.write(`sandbox: ${e.message}\n`);
  process.exit(1);
});
