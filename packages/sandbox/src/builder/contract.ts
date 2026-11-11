/** What the coding agent is told about the runtime. Also shipped as docs/CONTRACT.md. */
export const RUNTIME_DTS = `// Types available to every route module. Do not import anything except your own files under replica/.
export interface RouteResult { status: number; body: Uint8Array; headers: Record<string, string> }
export interface RouteContext {
  method: string;
  url: URL;
  path: string;
  /** Values of the {id} segments of the endpoint's path template, in order, URL-decoded. Always strings. */
  params: string[];
  query: Record<string, string>;
  /** Parsed application/x-www-form-urlencoded body, or {}. */
  form: Record<string, string>;
  /** Parsed JSON body, or undefined. */
  json: any;
  text: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  db: {
    get(sql: string, ...args: unknown[]): Record<string, any> | undefined;
    all(sql: string, ...args: unknown[]): Record<string, any>[];
    run(sql: string, ...args: unknown[]): { changes: number; lastInsertRowid: number };
  };
  /** Scratch space for one browser session. Cleared on reset. */
  session: Record<string, unknown>;
  /** The sandbox clock. Use it instead of Date.now(). */
  now(): Date;
  respond(status: number, body?: string | Uint8Array, headers?: Record<string, string>): RouteResult;
  json_(status: number, value: unknown, headers?: Record<string, string>): RouteResult;
  html(status: number, body: string, headers?: Record<string, string>): RouteResult;
  redirect(location: string, status?: number): RouteResult;
  /** The recorded answer to exactly this request, if there is one. A last resort: it does not generalise. */
  recorded(): RouteResult | undefined;
}
export interface RouteModule {
  /** Endpoint id from clusters.json, e.g. "c_0012". */
  cluster: string;
  kind: "read" | "write";
  handle(ctx: RouteContext): RouteResult | undefined | Promise<RouteResult | undefined>;
}
`;

export const CONTRACT_MD = `# Runtime contract

You are writing the backend of a local copy of a web app. The copy serves the app's own front-end files
unchanged; your code answers the requests that read or change data.

## Files you write (all under replica/)

- \`schema.sql\`: SQLite schema.
- \`seed.sql\`: INSERT statements. The data as it was **at the start of the earliest capture**, before any
  recorded write. The checker replays the recorded sessions in order from this state. A line
  \`{"reset":true}\` in timeline.jsonl means the real app's data was put back at that point; the checker
  returns to the seed there too.
- \`MODEL.md\`: one line per endpoint: which tables it reads or writes.
- \`routes/<cluster-id>.ts\`: one module per endpoint. Default-export \`{ cluster, kind, handle(ctx) }\`.
- \`templates/*.ts\`: shared functions that build HTML or JSON. Import them with a relative path that ends
  in \`.ts\`, for example \`import { page } from "../templates/page.ts"\`.

## Rules

1. **Plain TypeScript that Node can run by stripping types**: no enums, no namespaces, no parameter
   properties, no decorators. No imports except your own files under replica/. No network, no file access,
   no child processes, no \`Date.now()\` (use \`ctx.now()\`), no \`Math.random()\`.
2. **Generalise.** A handler must answer any instance of its endpoint from the database (any patient, any
   record), not only the examples you were shown. It is tested on instances you have not seen. A handler
   that returns stored copies of the examples will fail.
3. **Writes change the database.** After a recorded write, the recorded reads that followed must match.
4. **Match what the server sent**: status code, redirect location, JSON field names and order of array items,
   HTML structure. Whitespace between tags and attribute order do not matter. Fields listed as volatile in
   clusters.json (timestamps, request ids) are ignored by the checker; produce something of the same shape.
5. **Secrets were replaced** by placeholders such as \`SBX_CSRF_3\` and \`SBX_SESSION_1\`. Output a placeholder
   of the same type where the real page had a token; the number does not matter. Never validate tokens,
   cookies or passwords: in the copy every request is from the logged-in user.
6. **ctx.params are strings.** Convert before comparing with integer columns.
7. Unknown record: answer the way the recording shows the server answers (often a 404 page), or a 404.

## Inputs (read-only, under input/)

- \`clusters.json\`: every endpoint: id, method, path template, class (read, write, session, static, noise),
  counts, and which response fields are volatile.
- \`timeline.jsonl\`: the recorded exchanges in order: id, endpoint, method, URL, status.
- \`samples/<cluster-id>/<n>.json\`: full request and response for some exchanges. Large bodies are next to
  them as \`<n>.body\`.
- \`flow.json\`: values from one endpoint's response that appear in another endpoint's request (foreign keys).
- \`runtime.d.ts\`: the types of \`ctx\`.

## Checking your work

Run the check command you are given. It replays the recorded session against your code and prints the first
differences. Fix and re-run until it passes. You only see differences on the exchanges you were shown.
`;
