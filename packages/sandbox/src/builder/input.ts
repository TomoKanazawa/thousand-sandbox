import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAnalysis } from "../analyze/index.js";
import type { AppConfig, Cluster } from "../types.js";
import { type AppPaths, contentType, ensureDir, isTextType, readJson, writeJson } from "../util.js";
import { CONTRACT_MD, RUNTIME_DTS } from "./contract.js";

const MAX_SAMPLES = 12;
const INLINE_BYTES = 6_000;

/**
 * Write what the builder may see: the scrubbed build set only. Held-out exchanges and the raw capture
 * are never copied here.
 */
export function prepareInput(paths: AppPaths, config: AppConfig): { dir: string; targets: Cluster[] } {
  const dir = join(paths.build, "input");
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const { clusters, volatile, split, corpus } = loadAnalysis(paths, config);
  const visible = new Set(split.build);
  const classOf = new Map(clusters.map((c) => [c.id, c.class]));

  writeJson(
    join(dir, "clusters.json"),
    clusters.map((c) => ({
      id: c.id,
      key: c.key,
      method: c.method,
      pathTemplate: c.pathTemplate,
      discriminator: c.discriminator,
      class: c.class,
      count: c.count,
      instances: c.instances,
      contentType: c.contentType,
      statuses: c.statuses,
      volatile: volatile[c.id] ?? undefined,
    })),
  );
  writeJson(join(dir, "flow.json"), readJson(join(paths.analysis, "flow.json")));
  writeFileSync(join(dir, "CONTRACT.md"), CONTRACT_MD);
  writeFileSync(join(dir, "runtime.d.ts"), RUNTIME_DTS);

  const timeline: string[] = [];
  const perCluster = new Map<string, number>();
  const ordered = [...corpus.exchanges].sort((a, b) =>
    a.capture === b.capture ? a.ts - b.ts : a.capture.localeCompare(b.capture),
  );
  for (const x of ordered) {
    const cls = classOf.get(x.cluster ?? "");
    if (!x.cluster || cls === "static" || cls === "noise" || !cls) continue;
    if ((cls === "read" || cls === "write") && !visible.has(x.id)) continue;
    timeline.push(
      JSON.stringify({
        id: x.id,
        cluster: x.cluster,
        method: x.method,
        url: x.url,
        status: x.status,
        causedBy: x.causedBy ?? undefined,
      }),
    );
    const n = (perCluster.get(x.cluster) ?? 0) + 1;
    perCluster.set(x.cluster, n);
    if (n > MAX_SAMPLES) continue;
    const sdir = ensureDir(join(dir, "samples", x.cluster));
    const resCt = contentType(x.resHeaders);
    const resText = x.resBody && isTextType(resCt) ? x.bodies.text(x.resBody) : undefined;
    let body: string | undefined = resText;
    let bodyFile: string | undefined;
    if (resText && resText.length > INLINE_BYTES) {
      bodyFile = `${n}.body`;
      writeFileSync(join(sdir, bodyFile), resText);
      body = undefined;
    }
    writeJson(join(sdir, `${n}.json`), {
      id: x.id,
      request: {
        method: x.method,
        url: x.url,
        contentType: contentType(x.reqHeaders) || undefined,
        body: x.reqText || undefined,
        pathParams: x.parsed.pathParams,
      },
      response: {
        status: x.status,
        contentType: resCt || undefined,
        location: x.resHeaders.find(([k]) => k.toLowerCase() === "location")?.[1],
        body,
        bodyFile,
        binary: x.resBody && resText === undefined ? true : undefined,
      },
    });
  }
  writeFileSync(join(dir, "timeline.jsonl"), `${timeline.join("\n")}\n`);

  const targets = clusters.filter((c) => (c.class === "read" || c.class === "write") && perCluster.has(c.id));
  return { dir, targets };
}
