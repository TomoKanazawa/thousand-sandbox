import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { faker } from "@faker-js/faker";
import type { CaptureEvent, Headers, Manifest } from "../types.js";
import {
  type AppPaths,
  BodyStore,
  contentType,
  ensureDir,
  isTextType,
  parseBody,
  readEvents,
  readJson,
  sha256,
  writeJson,
} from "../util.js";

/**
 * Two copies of a capture exist: the raw one (never sent anywhere) and the scrubbed one in `scrubbed/`,
 * which is what analysis, the model and the replica use.
 *
 * mode "secrets": session cookies, tokens and passwords become typed placeholders (SBX_SESSION_1, ...).
 * mode "pii": also replaces personal data with consistent fakes of the same shape.
 * Automated de-identification is not a guarantee; review with `sandbox scrub --review`.
 */

const SECRET_HEADERS = /^(cookie|authorization|proxy-authorization|x-csrf.*|x-xsrf.*|x-api-key|x-auth.*)$/i;
const TOKEN_NAMES =
  /^(csrf.*|.*csrf|_?token|access_token|refresh_token|id_token|authenticity_token|__requestverificationtoken|nonce|pre|api_?key|secret|session_?id|sid|jsessionid|phpsessid)$/i;
const PASSWORD_NAMES = /^(pass(word|wd)?|pwd|otp|pin|passcode|clearpass|newpass.*|authpass)$/i;

const PII_FIELD: [RegExp, Kind][] = [
  [/^(f(irst)?[_-]?name|fname|given[_-]?name|first)$/i, "first"],
  [/^(l(ast)?[_-]?name|lname|family[_-]?name|surname|last)$/i, "last"],
  [/^(m(iddle)?[_-]?name|mname)$/i, "first"],
  [/^(full[_-]?name|patient[_-]?name|name|display[_-]?name)$/i, "full"],
  [/^(dob|date[_-]?of[_-]?birth|birth[_-]?date|birthdate)$/i, "date"],
  [/^(ssn|social.*|ss)$/i, "ssn"],
  [/^(phone.*|.*phone|mobile|cell|fax|tel)$/i, "phone"],
  [/^(e?mail.*|.*email)$/i, "email"],
  [/^(street.*|address.*|addr.*|line1|line2)$/i, "street"],
  [/^(mrn|pubpid|med(ical)?[_-]?rec.*|patient[_-]?id[_-]?ext|chart[_-]?no)$/i, "id"],
  [/^(zip|postal.*|postcode)$/i, "zip"],
];
type Kind = "first" | "last" | "full" | "date" | "ssn" | "phone" | "email" | "street" | "id" | "zip";

const PII_REGEX: [RegExp, Kind][] = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "email"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "ssn"],
  [/(?<![\d-])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\d-])/g, "phone"],
];

function seedFrom(s: string) {
  return Number.parseInt(sha256(s).slice(0, 8), 16);
}

/** Replace letters and digits with other letters and digits, keeping length, case and punctuation. */
function sameShape(real: string): string {
  let h = seedFrom(real);
  const next = () => {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h;
  };
  return real.replace(/[A-Za-z0-9]/g, (c) => {
    if (/\d/.test(c)) return String(next() % 10);
    const a = c >= "a" ? 97 : 65;
    return String.fromCharCode(a + (next() % 26));
  });
}

function fakeFor(kind: Kind, real: string): string {
  faker.seed(seedFrom(`${kind}:${real.toLowerCase()}`));
  switch (kind) {
    case "first":
      return faker.person.firstName();
    case "last":
      return faker.person.lastName();
    case "full":
      return `${faker.person.firstName()} ${faker.person.lastName()}`;
    case "email":
      return faker.internet.email().toLowerCase();
    case "street":
      return faker.location.streetAddress();
    case "date": {
      // Shift by a fixed offset of up to about a year, keeping the format.
      const offset = (seedFrom(real) % 300) + 30;
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(real);
      const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(real);
      const d = iso
        ? new Date(Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!))
        : us
          ? new Date(Date.UTC(+us[3]!, +us[1]! - 1, +us[2]!))
          : null;
      if (!d || Number.isNaN(d.getTime())) return sameShape(real);
      d.setUTCDate(d.getUTCDate() - offset);
      const p = (n: number) => String(n).padStart(2, "0");
      return iso
        ? `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}${real.slice(iso[0].length)}`
        : `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
    }
    default:
      return sameShape(real);
  }
}

export interface ScrubReport {
  capture: string;
  mode: "secrets" | "pii";
  secrets: number;
  pii: number;
  replacements: number;
  samples: { kind: string; fake: string }[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function scrubCapture(paths: AppPaths, id: string, mode: "secrets" | "pii"): Promise<ScrubReport> {
  const base = join(paths.captures, id);
  const out = join(base, "scrubbed");
  rmSync(out, { recursive: true, force: true });
  ensureDir(join(out, "episodes"));
  ensureDir(join(out, "snapshots"));
  const raw = new BodyStore(join(base, "bodies"));
  const clean = new BodyStore(join(out, "bodies"));
  const events = readEvents(base);

  // real value -> replacement. The same real value always maps to the same replacement, across captures.
  const pseudoFile = join(paths.root, "pseudonyms.json");
  const known: Record<string, string> = existsSync(pseudoFile) ? readJson(pseudoFile) : {};
  const map = new Map<string, string>(Object.entries(known));
  const counters: Record<string, number> = {};
  for (const v of map.values()) {
    const m = /^SBX_([A-Z]+)_(\d+)$/.exec(v);
    if (m) counters[m[1]!] = Math.max(counters[m[1]!] ?? 0, +m[2]!);
  }
  let secrets = 0;
  let pii = 0;
  const addSecret = (value: string | undefined | null, type: "SESSION" | "CSRF" | "SECRET" | "PASSWORD") => {
    if (!value || value.length < 6 || /^SBX_/.test(value) || map.has(value)) return;
    counters[type] = (counters[type] ?? 0) + 1;
    map.set(value, `SBX_${type}_${counters[type]}`);
    secrets++;
  };
  const addPii = (value: string | undefined | null, kind: Kind) => {
    const v = value?.trim();
    if (!v || v.length < 3 || map.has(v) || /^SBX_/.test(v) || /^(true|false|null|none|unknown|n\/a)$/i.test(v)) return;
    if ((kind === "first" || kind === "last" || kind === "full") && !/^[\p{L}][\p{L}' .-]+$/u.test(v)) return;
    map.set(v, fakeFor(kind, v));
    pii++;
  };

  const typeOfName = (name: string) =>
    PASSWORD_NAMES.test(name)
      ? "PASSWORD"
      : /csrf|xsrf|authenticity|verification|nonce|^pre$/i.test(name)
        ? "CSRF"
        : "SECRET";
  const scanFields = (fields: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(fields)) {
      if (v && typeof v === "object") {
        if (!Array.isArray(v)) scanFields(v as Record<string, unknown>);
        else for (const item of v) if (item && typeof item === "object") scanFields(item as Record<string, unknown>);
        continue;
      }
      if (typeof v !== "string" && typeof v !== "number") continue;
      const s = String(v);
      if (TOKEN_NAMES.test(k) || PASSWORD_NAMES.test(k)) addSecret(s, typeOfName(k));
      else if (mode === "pii") for (const [re, kind] of PII_FIELD) if (re.test(k)) addPii(s, kind);
    }
  };
  const scanText = (ct: string, text: string) => {
    const { form, json } = parseBody(ct, text);
    if (form) scanFields(form);
    if (json && typeof json === "object")
      scanFields(Array.isArray(json) ? { _: json } : (json as Record<string, unknown>));
    if (/html/.test(ct) || /^\s*</.test(text)) {
      for (const m of text.matchAll(/<input\b[^>]*>/gi)) {
        const tag = m[0];
        const name = /\bname=["']?([^"'\s>]+)/i.exec(tag)?.[1];
        const value = /\bvalue=["']([^"']*)["']/i.exec(tag)?.[1];
        if (name && value) scanFields({ [name]: value });
      }
      // Values shown in elements whose id, class or name says what they are: <dd id="dob">1961-03-14</dd>.
      for (const m of text.matchAll(
        /<\w+\b[^>]*\b(?:id|class|name|data-field|headers)=["']([^"']{1,60})["'][^>]*>([^<]{2,80})</g,
      ))
        for (const token of m[1]!.split(/\s+/))
          if (mode === "pii") for (const [re, kind] of PII_FIELD) if (re.test(token)) addPii(m[2], kind);
      for (const m of text.matchAll(/<meta\b[^>]*name=["']([^"']+)["'][^>]*content=["']([^"']+)["']/gi))
        if (/csrf|xsrf|token/i.test(m[1]!)) addSecret(m[2], "CSRF");
    }
    if (mode === "pii") for (const [re, kind] of PII_REGEX) for (const m of text.matchAll(re)) addPii(m[0], kind);
  };

  // Pass 1: find secrets and personal data.
  for (const e of events) {
    if (e.type === "exchange" || e.type === "probe") {
      const reqHeaders: Headers = e.type === "exchange" ? e.reqHeaders : [];
      for (const [k, v] of reqHeaders) {
        if (/^cookie$/i.test(k))
          for (const part of v.split(/;\s*/)) addSecret(part.slice(part.indexOf("=") + 1), "SESSION");
        else if (/^authorization$/i.test(k)) addSecret(v.replace(/^\w+\s+/, ""), "SECRET");
        else if (SECRET_HEADERS.test(k)) addSecret(v, /csrf|xsrf/i.test(k) ? "CSRF" : "SECRET");
      }
      for (const [k, v] of e.resHeaders)
        if (/^set-cookie$/i.test(k))
          for (const line of v.split("\n")) addSecret(line.split(";")[0]!.slice(line.indexOf("=") + 1), "SESSION");
      if (e.type === "exchange") {
        const u = new URL(e.url);
        scanFields(Object.fromEntries(u.searchParams));
        if (e.reqBody) scanText(contentType(e.reqHeaders), raw.text(e.reqBody));
      }
      const ct = contentType(e.resHeaders);
      if (e.resBody && isTextType(ct)) scanText(ct, raw.text(e.resBody));
    }
  }

  // Pass 2: replace everywhere. Longest first so a value inside a longer value is not split.
  const keys = [...map.keys()].filter((k) => k.length >= 3).sort((a, b) => b.length - a.length);
  const re = keys.length
    ? new RegExp(
        keys
          .map((k) =>
            /^\w/.test(k) && /\w$/.test(k) && k.length < 12 ? `(?<![\\w])${escapeRe(k)}(?![\\w])` : escapeRe(k),
          )
          .join("|"),
        "g",
      )
    : null;
  let replacements = 0;
  const sub = (s: string) => {
    if (!re || !s) return s;
    return s.replace(re, (m) => {
      replacements++;
      return map.get(m) ?? m;
    });
  };
  const subUrlEncoded = (s: string) => {
    // Values can also appear URL-encoded in query strings and form bodies.
    let outS = sub(s);
    for (const k of keys) {
      const enc = encodeURIComponent(k);
      if (enc !== k && outS.includes(enc)) outS = outS.split(enc).join(encodeURIComponent(map.get(k)!));
    }
    return outS;
  };
  const subHeaders = (h: Headers): Headers => h.map(([k, v]) => [k, sub(v)]);
  const subBody = (hash: string | undefined, ct: string): string | undefined => {
    if (!hash) return undefined;
    const buf = raw.get(hash);
    if (!isTextType(ct) && !/^\s*[<{[]/.test(buf.subarray(0, 64).toString("utf8"))) return clean.put(buf);
    return clean.put(subUrlEncoded(buf.toString("utf8")));
  };

  const perEpisode = new Map<string, string[]>();
  for (const e of events) {
    let o: CaptureEvent = e;
    if (e.type === "exchange")
      o = {
        ...e,
        url: subUrlEncoded(e.url),
        reqHeaders: subHeaders(e.reqHeaders),
        resHeaders: subHeaders(e.resHeaders),
        reqBody: subBody(e.reqBody, contentType(e.reqHeaders) || "text/plain"),
        resBody: subBody(e.resBody, contentType(e.resHeaders)),
      };
    else if (e.type === "probe")
      o = { ...e, resHeaders: subHeaders(e.resHeaders), resBody: subBody(e.resBody, contentType(e.resHeaders)) };
    else if (e.type === "action")
      o = {
        ...e,
        value: e.value ? sub(e.value) : e.value,
        pageUrl: subUrlEncoded(e.pageUrl),
        target: e.target
          ? {
              ...e.target,
              name: sub(e.target.name ?? ""),
              href: e.target.href ? subUrlEncoded(e.target.href) : undefined,
            }
          : undefined,
      };
    else if (e.type === "ws") o = { ...e, payload: e.payload && !e.binary ? sub(e.payload) : e.payload };
    else if (e.type === "snapshot") o = { ...e, url: subUrlEncoded(e.url), title: sub(e.title) };
    else o = { ...e, text: sub(e.text) };
    const ep = (e as CaptureEvent & { episode?: string }).episode ?? "1";
    const { episode: _drop, ...rest } = o as CaptureEvent & { episode?: string };
    if (!perEpisode.has(ep)) perEpisode.set(ep, []);
    perEpisode.get(ep)!.push(JSON.stringify(rest));
  }
  for (const [ep, lines] of perEpisode) writeFileSync(join(out, "episodes", `${ep}.jsonl`), `${lines.join("\n")}\n`);

  const snapDir = join(base, "snapshots");
  if (existsSync(snapDir))
    for (const f of readdirSync(snapDir)) {
      if (f.endsWith(".png")) {
        // Screenshots can show personal data; they are kept out of the scrubbed copy unless only secrets are scrubbed.
        if (mode === "secrets") copyFileSync(join(snapDir, f), join(out, "snapshots", f));
      } else writeFileSync(join(out, "snapshots", f), sub(readFileSync(join(snapDir, f), "utf8")));
    }

  writeJson(pseudoFile, Object.fromEntries(map));
  const manifest = readJson<Manifest>(join(base, "manifest.json"));
  manifest.scrub = mode;
  if (mode === "pii") manifest.phi = true;
  writeJson(join(base, "manifest.json"), manifest);

  const samples = [...map.entries()]
    .slice(-12)
    .map(([, fake]) => ({ kind: /^SBX_/.test(fake) ? fake.replace(/_\d+$/, "") : "personal", fake }));
  return { capture: id, mode, secrets, pii, replacements, samples };
}

/** Strings that look personal but were not replaced: shown in the review so a person can judge. */
export function reviewSample(paths: AppPaths, id: string, limit = 20): string[] {
  const dir = join(paths.captures, id, "scrubbed");
  const bodies = new BodyStore(join(dir, "bodies"));
  const found = new Set<string>();
  for (const e of readEvents(dir)) {
    if (e.type !== "exchange" || !e.resBody || !isTextType(contentType(e.resHeaders))) continue;
    const text = bodies.text(e.resBody);
    for (const m of text.matchAll(
      /\b[A-Z][a-z]{2,},?\s[A-Z][a-z]{2,}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g,
    )) {
      found.add(m[0]);
      if (found.size >= limit) return [...found];
    }
  }
  return [...found];
}
