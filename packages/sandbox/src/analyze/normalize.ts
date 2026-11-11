import { parse as parseHtml } from "node-html-parser";

export interface Rules {
  jsonPaths: string[];
  textContexts: string[];
  headers: string[];
}
export const NO_RULES: Rules = { jsonPaths: [], textContexts: [], headers: [] };

const MASK = "\u00a7";
const SPLIT = /(\s+|[<>"'=&;,(){}[\]])/;

export function tokens(text: string): string[] {
  return text.split(SPLIT).filter((t) => t && !SPLIT.test(t));
}

const genericPath = (path: string) => path.replace(/\[\d+\]/g, "[*]");

function walk(value: unknown, path: string, fn: (path: string, v: unknown) => void) {
  if (value === null || typeof value !== "object") return fn(path, value);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, fn));
  else for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, fn);
}

/** Learn which parts of two answers to the same question differ. */
export function learn(isJson: boolean, a: string, b: string, into: Rules) {
  if (a === b) return;
  if (isJson) {
    try {
      const fa: Record<string, unknown> = {};
      const fb: Record<string, unknown> = {};
      walk(JSON.parse(a), "", (p, v) => {
        fa[p] = v;
      });
      walk(JSON.parse(b), "", (p, v) => {
        fb[p] = v;
      });
      for (const p of Object.keys(fa))
        if (p in fb && fa[p] !== fb[p] && !into.jsonPaths.includes(genericPath(p))) into.jsonPaths.push(genericPath(p));
      return;
    } catch {}
  }
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length !== tb.length) return;
  for (let i = 0; i < ta.length; i++) {
    if (ta[i] === tb[i]) continue;
    const ctx = `${ta[i - 2] ?? ""} ${ta[i - 1] ?? ""}`;
    if (ta[i - 1] !== tb[i - 1]) continue; // part of a run; the first token of the run carries the rule
    if (!into.textContexts.includes(ctx)) into.textContexts.push(ctx);
  }
}

function maskJson(value: unknown, path: string, rules: Rules): unknown {
  if (rules.jsonPaths.includes(genericPath(path))) return MASK;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v, i) => maskJson(v, `${path}[${i}]`, rules));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort())
    out[k] = maskJson((value as Record<string, unknown>)[k], path ? `${path}.${k}` : k, rules);
  return out;
}

function canonicalHtml(html: string): string {
  try {
    const root = parseHtml(html, { comment: false });
    const out: string[] = [];
    const visit = (node: ReturnType<typeof parseHtml>) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const t = child.rawText.replace(/\s+/g, " ").trim();
          if (t) out.push(t);
        } else if (child.nodeType === 1) {
          const el = child as ReturnType<typeof parseHtml>;
          const attrs = Object.entries(el.attributes)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}="${v}"`)
            .join(" ");
          out.push(`<${el.rawTagName}${attrs ? ` ${attrs}` : ""}>`);
          visit(el);
          out.push(`</${el.rawTagName}>`);
        }
      }
    };
    visit(root);
    return out.join("\n");
  } catch {
    return html;
  }
}

/** Put a response body into a comparable form: volatile parts masked, formatting noise removed. */
export function normalizeBody(contentType: string, raw: string, rules: Rules = NO_RULES): string {
  // Placeholders for secrets are numbered in the order they were met; which number it is carries no meaning.
  const text = raw.replace(/SBX_([A-Z]+)_\d+/g, "SBX_$1");
  if (/json/.test(contentType) || /^\s*[[{]/.test(text)) {
    try {
      return JSON.stringify(maskJson(JSON.parse(text), "", rules));
    } catch {}
  }
  let body = /html/.test(contentType) ? canonicalHtml(text) : text;
  if (rules.textContexts.length) {
    const parts = body.split(SPLIT);
    let prev2 = "";
    let prev1 = "";
    let masking = false;
    for (let i = 0; i < parts.length; i++) {
      const t = parts[i]!;
      if (!t || SPLIT.test(t)) continue;
      const hit = rules.textContexts.includes(`${prev2} ${prev1}`);
      prev2 = prev1;
      prev1 = t;
      if (hit) {
        parts[i] = MASK;
        masking = true;
      } else masking = false;
    }
    void masking;
    body = parts.join("");
  }
  return body;
}

/** First difference between two normalised bodies, short enough to print. */
export function firstDiff(a: string, b: string): string {
  if (a === b) return "";
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 40);
  return `at ${i}: expected …${a.slice(from, i + 60).replace(/\n/g, "⏎")}… got …${b.slice(from, i + 60).replace(/\n/g, "⏎")}…`;
}
