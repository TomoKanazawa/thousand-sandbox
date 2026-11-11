import { parseBody } from "../util.js";

const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|SBX_[A-Z]+_\d+|(?=[\w-]*\d)(?=[\w-]*[a-zA-Z])[\w-]{20,})$/i;
const DISCRIMINATORS = [
  "action",
  "cmd",
  "method",
  "op",
  "task",
  "mode",
  "do",
  "command",
  "operationName",
  "fn",
  "func",
];
/** Parameter names that are almost always cache busters or tokens. */
export const VOLATILE_PARAM_NAMES =
  /^(_|_t|t|ts|cb|cachebust(er)?|nocache|rand(om)?|rnd|timestamp|_dc|v|ver|csrf.*|.*csrf|_token|authenticity_token|nonce|__requestverificationtoken|pre)$/i;
const VOLATILE_VALUE = /^(\d{10}|\d{13}|0\.\d{8,}|SBX_[A-Z]+_\d+)$/;

export function templatePath(pathname: string): { template: string; params: string[] } {
  const params: string[] = [];
  const template = pathname
    .split("/")
    .map((seg) => {
      let s = seg;
      try {
        s = decodeURIComponent(seg);
      } catch {}
      if (s && ID_SEGMENT.test(s)) {
        params.push(s);
        return "{id}";
      }
      return seg;
    })
    .join("/");
  return { template, params };
}

export interface ParsedRequest {
  method: string;
  host: string;
  origin: string;
  pathTemplate: string;
  pathParams: string[];
  query: Record<string, string>;
  form?: Record<string, string>;
  json?: unknown;
  discriminator?: { name: string; value: string };
  /** METHOD host pathTemplate [name=value] */
  key: string;
}

export function parseRequest(method: string, url: string, contentType = "", bodyText = ""): ParsedRequest {
  const u = new URL(url);
  const { template, params } = templatePath(u.pathname);
  const query: Record<string, string> = {};
  for (const [k, v] of u.searchParams) query[k] = v;
  const { form, json } = bodyText ? parseBody(contentType, bodyText) : {};
  let discriminator: ParsedRequest["discriminator"];
  const jsonObj =
    json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  for (const name of DISCRIMINATORS) {
    const v =
      query[name] ?? form?.[name] ?? (typeof jsonObj?.[name] === "string" ? (jsonObj[name] as string) : undefined);
    if (v && v.length <= 60 && /^[\w.:/-]+$/.test(v) && !/^\d+$/.test(v)) {
      discriminator = { name, value: v };
      break;
    }
  }
  if (!discriminator && jsonObj && typeof jsonObj.query === "string") {
    const m = /^\s*(query|mutation)\s+(\w+)/.exec(jsonObj.query);
    if (m) discriminator = { name: "graphql", value: `${m[1]}:${m[2]}` };
  }
  const key = `${method.toUpperCase()} ${u.host} ${template}${discriminator ? ` [${discriminator.name}=${discriminator.value}]` : ""}`;
  return {
    method: method.toUpperCase(),
    host: u.host,
    origin: u.origin,
    pathTemplate: template,
    pathParams: params,
    query,
    form,
    json,
    discriminator,
    key,
  };
}

function flatten(value: unknown, prefix: string, out: Record<string, string>) {
  if (value === null || typeof value !== "object") {
    out[prefix] = String(value);
    return;
  }
  if (Array.isArray(value)) value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
}

/** All request parameters (path, query, body) as a flat map. */
export function requestParams(p: ParsedRequest): Record<string, string> {
  const out: Record<string, string> = {};
  p.pathParams.forEach((v, i) => {
    out[`path.${i}`] = v;
  });
  for (const [k, v] of Object.entries(p.query)) out[`query.${k}`] = v;
  if (p.form) for (const [k, v] of Object.entries(p.form)) out[`body.${k}`] = v;
  if (p.json !== undefined) flatten(p.json, "body", out);
  return out;
}

export const isVolatileParam = (name: string, value: string, learned: string[] = []) => {
  const bare = name.replace(/^(query|body|path)\./, "");
  return learned.includes(name) || VOLATILE_PARAM_NAMES.test(bare) || VOLATILE_VALUE.test(value);
};

/** Identity of a request inside its cluster, ignoring volatile parameters. Two requests with one instance key ask for the same thing. */
export function instanceKey(p: ParsedRequest, learnedVolatile: string[] = []): string {
  const params = requestParams(p);
  const parts = Object.keys(params)
    .sort()
    .filter((k) => !isVolatileParam(k, params[k]!, learnedVolatile))
    .map((k) => `${k}=${params[k]}`);
  return `${p.key} | ${parts.join("&")}`;
}

// ---------- matching an incoming request to a known cluster ----------

export interface ClusterRef {
  id: string;
  method: string;
  host: string;
  pathTemplate: string;
  discriminator?: { name: string; value: string };
}

const templateRe = new Map<string, RegExp>();
export function templateRegex(template: string): RegExp {
  let re = templateRe.get(template);
  if (!re) {
    re = new RegExp(
      `^${template
        .split("{id}")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("([^/]+)")}$`,
    );
    templateRe.set(template, re);
  }
  return re;
}

/** Find the cluster for a request: same method and host, path matches the template, discriminator agrees. Most specific wins. */
export function matchCluster<T extends ClusterRef>(
  clusters: T[],
  p: ParsedRequest,
  pathname: string,
): { cluster: T; pathParams: string[] } | undefined {
  let best: { cluster: T; pathParams: string[]; score: number } | undefined;
  for (const c of clusters) {
    if (c.method !== p.method || c.host !== p.host) continue;
    const m = templateRegex(c.pathTemplate).exec(pathname);
    if (!m) continue;
    if (c.discriminator) {
      if (p.discriminator?.name !== c.discriminator.name || p.discriminator.value !== c.discriminator.value) continue;
    }
    const score = (c.discriminator ? 1000 : 0) + c.pathTemplate.length - 10 * (c.pathTemplate.split("{id}").length - 1);
    if (!best || score > best.score) best = { cluster: c, pathParams: m.slice(1), score };
  }
  return best;
}

/** Parse an incoming request and attach it to a known cluster. */
export function resolveRequest<T extends ClusterRef & { key: string }>(
  clusters: T[],
  method: string,
  url: string,
  contentType: string,
  bodyText: string,
) {
  const parsed = parseRequest(method, url, contentType, bodyText);
  const hit = matchCluster(clusters, parsed, new URL(url).pathname);
  if (hit) {
    parsed.pathTemplate = hit.cluster.pathTemplate;
    parsed.pathParams = hit.pathParams.map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    parsed.key = hit.cluster.key;
  }
  return { parsed, cluster: hit?.cluster, instance: instanceKey(parsed) };
}
