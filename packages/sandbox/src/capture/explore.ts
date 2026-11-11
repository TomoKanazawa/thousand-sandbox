import type { Page } from "playwright";
import { templatePath } from "../analyze/cluster.js";
import { log, sha256 } from "../util.js";
import { type ControlInfo, judgeClick } from "./gate.js";
import { CONTROLS_SCRIPT } from "./pagescript.js";
import type { Recorder } from "./recorder.js";

type Control = ControlInfo & { ref: number };

/** A screen is the same state when only its data differs: URL template + page skeleton with text and numbers masked. */
async function stateKey(page: Page): Promise<string> {
  const u = new URL(page.url());
  let aria = "";
  try {
    aria = await page.locator("body").ariaSnapshot({ timeout: 3000 });
  } catch {}
  const skeleton = aria
    .split("\n")
    .map((l) =>
      l
        .replace(/"[^"]*"/g, '""')
        .replace(/:\s.*$/, ":")
        .replace(/\d+/g, "0"),
    )
    .filter((l, i, a) => l !== a[i - 1])
    .join("\n");
  return sha256(`${u.origin}${templatePath(u.pathname).template}\n${skeleton}`).slice(0, 16);
}

const controlKey = (c: Control) =>
  `${c.tag}|${c.name.replace(/\d+/g, "0")}|${c.href ? templatePath(new URL(c.href).pathname).template : ""}`;

/**
 * Breadth-first exploration with no model: try each safe control once per state, return to the state by URL.
 * The UI gate refuses commit controls; the network gate (set up by the caller) stops unknown writes.
 */
export async function explore(
  page: Page,
  recorder: Recorder,
  opts: { origins: string[]; maxActions: number; allowWrites: boolean; perState?: number },
) {
  const perState = opts.perState ?? 25;
  const visited = new Map<string, { url: string; tried: Set<string> }>();
  const queue: string[] = [];
  const refused = new Map<string, string>();
  let actions = 0;
  let sinceNew = 0;

  const enter = async () => {
    const key = await stateKey(page);
    if (!visited.has(key)) {
      visited.set(key, { url: page.url(), tried: new Set() });
      queue.push(key);
      sinceNew = 0;
    }
    return key;
  };
  await enter();

  while (queue.length && actions < opts.maxActions && sinceNew < 100) {
    const key = queue.shift()!;
    const state = visited.get(key)!;
    let patternCount = new Map<string, number>();
    for (let n = 0; n < perState && actions < opts.maxActions; n++) {
      if ((await stateKey(page)) !== key) {
        try {
          await page.goto(state.url, { waitUntil: "domcontentloaded" });
          await recorder.settle();
        } catch {
          break;
        }
      }
      let controls: Control[] = [];
      try {
        controls = (await page.evaluate(CONTROLS_SCRIPT)) as Control[];
      } catch {
        break;
      }
      patternCount = new Map();
      const next = controls.find((c) => {
        const ck = controlKey(c);
        // In repeated lists, open only the first two rows of each pattern.
        const seen = patternCount.get(ck) ?? 0;
        patternCount.set(ck, seen + 1);
        if (state.tried.has(`${ck}#${c.name}`)) return false;
        if (seen >= 2) {
          state.tried.add(`${ck}#${c.name}`);
          return false;
        }
        if (c.href) {
          try {
            if (!opts.origins.includes(new URL(c.href).origin)) return false;
          } catch {
            return false;
          }
        }
        const why = judgeClick(c, { allowWrites: opts.allowWrites });
        if (why) {
          state.tried.add(`${ck}#${c.name}`);
          if (!refused.has(c.name)) {
            refused.set(c.name, why);
            recorder.note("gate", `refused control "${c.name}" (${why})`);
          }
          return false;
        }
        return true;
      });
      if (!next) break;
      state.tried.add(`${controlKey(next)}#${next.name}`);
      actions++;
      sinceNew++;
      try {
        await page.locator(`[data-sbx="${next.ref}"]`).first().click({ timeout: 4000 });
      } catch {
        continue;
      }
      await recorder.settle();
      await new Promise((r) => setTimeout(r, 150));
      if (!opts.origins.includes(new URL(page.url()).origin)) {
        await page.goBack().catch(() => {});
        continue;
      }
      await enter();
    }
  }
  log(`Explored ${visited.size} states with ${actions} actions; refused ${refused.size} controls.`);
  return { states: visited.size, actions, refused: [...refused.entries()] };
}
