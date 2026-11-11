/** File formats shared by every stage. See docs/FORMATS.md. */

export type Headers = [string, string][];

export const REQUEST_CLASSES = ["static", "read", "write", "session", "noise", "uncaptured"] as const;
export type RequestClass = (typeof REQUEST_CLASSES)[number];

export const LEDGER_LABELS = ["verified", "replayed-only", "inferred", "uncaptured", "external"] as const;
export type LedgerLabel = (typeof LEDGER_LABELS)[number];

interface Base {
  id: string;
  /** Milliseconds since the episode started. */
  ts: number;
}

export interface ActionEvent extends Base {
  type: "action";
  kind: "click" | "type" | "select" | "key" | "submit" | "navigate";
  target?: { tag: string; role?: string; name?: string; selector?: string; href?: string; inputType?: string };
  value?: string;
  source: "human" | "agent" | "script";
  pageUrl: string;
  frameUrl?: string;
  snapshotBefore?: string;
  snapshotAfter?: string;
}

export interface ExchangeEvent extends Base {
  type: "exchange";
  method: string;
  url: string;
  reqHeaders: Headers;
  /** sha256 of the request body in bodies/. */
  reqBody?: string;
  status: number;
  resHeaders: Headers;
  resBody?: string;
  resourceType: string;
  endTs: number;
  causedBy: string | null;
  failed?: string;
  /** Set when the network gate stopped the request during exploration. */
  blocked?: boolean;
}

export interface ProbeEvent extends Base {
  type: "probe";
  of: string;
  status: number;
  resHeaders: Headers;
  resBody?: string;
}

export interface WsEvent extends Base {
  type: "ws";
  socket: string;
  url: string;
  direction: "sent" | "received" | "open" | "close";
  payload?: string;
  binary?: boolean;
  causedBy: string | null;
}

export interface SnapshotEvent extends Base {
  type: "snapshot";
  reason: "start" | "load" | "settled" | "probe" | "end";
  url: string;
  title: string;
  /** File stems in snapshots/: <id>.html, <id>.aria.txt, optional <id>.png. */
  files: string[];
  after?: string;
}

export interface NoteEvent extends Base {
  type: "console" | "dialog" | "popup" | "download" | "gate";
  text: string;
}

export type CaptureEvent = ActionEvent | ExchangeEvent | ProbeEvent | WsEvent | SnapshotEvent | NoteEvent;

export interface Manifest {
  toolVersion: string;
  id: string;
  origins: string[];
  startUrl: string;
  startedAt: string;
  endedAt?: string;
  browser?: string;
  viewport?: { width: number; height: number };
  mode: "human" | "explore" | "script" | "drift";
  allowWrites: boolean;
  episodes: number;
  scrub: "none" | "secrets" | "pii";
  phi?: boolean;
  reviewed?: boolean;
  label?: string;
  /** The app's data had been put back to its starting state before this capture (a test system that was reset). */
  afterReset?: boolean;
}

export interface AppConfig {
  app: string;
  startUrl: string;
  /** Origins the copy answers for, e.g. https://ehr.example.com */
  origins: string[];
  scrub: "secrets" | "pii";
  models: { model: string; implement: string; triage: string };
  budgets: { buildUsd: number; exploreActions: number };
  telemetry: boolean;
}

export interface Cluster {
  id: string;
  /** Stable key: METHOD host pathTemplate [param=value]. */
  key: string;
  method: string;
  host: string;
  pathTemplate: string;
  discriminator?: { name: string; value: string };
  class: RequestClass;
  classReason: string;
  count: number;
  instances: number;
  resourceTypes: string[];
  contentType?: string;
  statuses: number[];
  /** Request query/body parameter names that change without changing the response. */
  volatileParams: string[];
  exchangeIds: string[];
}

export interface VolatileRules {
  /** cluster id -> rules */
  [cluster: string]: { jsonPaths: string[]; textContexts: string[]; headers: string[] };
}

export interface Split {
  build: string[];
  heldOut: string[];
  /** Read-after-write checks: a write and the reads that followed it in the same episode. */
  l3: { write: string; reads: string[] }[];
}

export interface PolicyEntry {
  decision: "read" | "write" | "unknown";
  by: "default" | "heuristic" | "evidence" | "user";
  note?: string;
}
export type Policy = Record<string, PolicyEntry>;

export interface LedgerEntry {
  cluster: string;
  key: string;
  class: RequestClass;
  label: LedgerLabel;
  served: "static" | "replay" | "generated" | "stub" | "none";
  checks: { l1: [number, number]; l2: [number, number]; l3: [number, number] };
  evidence: string[];
  failures: { level: "l1" | "l2" | "l3"; exchange: string; diff: string }[];
}

export interface Ledger {
  builtAt: string;
  replicaHash: string;
  clusters: LedgerEntry[];
  actions: { action: string; name: string; label: LedgerLabel; clusters: string[] }[];
  summary: Record<LedgerLabel, number>;
}
