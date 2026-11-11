import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./types.js";
import { type AppPaths, appNameFromUrl, appPaths, ensureDir, saveConfig } from "./util.js";

/** Create `.sandbox/<app>/` and its config. */
export function initApp(
  url: string,
  opts: { cwd?: string; app?: string; origins?: string[] } = {},
): { paths: AppPaths; config: AppConfig } {
  const cwd = opts.cwd ?? process.cwd();
  const u = new URL(url);
  const app = opts.app ?? appNameFromUrl(url);
  const paths = appPaths(app, cwd);
  ensureDir(paths.root);
  const config: AppConfig = {
    app,
    startUrl: u.href,
    origins: opts.origins ?? [u.origin],
    scrub: "secrets",
    models: { model: "claude-opus-5-5", implement: "claude-sonnet-5-5", triage: "claude-sonnet-5-5" },
    budgets: { buildUsd: 40, exploreActions: 300 },
    telemetry: false,
  };
  saveConfig(paths, config);
  const gi = join(cwd, ".gitignore");
  if (
    !existsSync(gi) ||
    !readFileSync(gi, "utf8")
      .split("\n")
      .some((l) => l.trim() === ".sandbox/")
  )
    appendFileSync(gi, `${existsSync(gi) ? "\n" : ""}.sandbox/\n`);
  return { paths, config };
}
