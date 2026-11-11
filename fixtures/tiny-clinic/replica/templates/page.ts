export const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** The page shell. The token is the placeholder the scrubber put in place of the real CSRF token. */
export function page(title: string, body: string, now: Date): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - Tiny Clinic</title>
<meta name="csrf" content="SBX_CSRF_1"><link rel="stylesheet" href="/style.css"></head><body>
<nav><a href="/patients">Patients</a><a href="/search">Search</a><a href="/logout">Log out</a></nav>
<h1>${esc(title)}</h1>
${body}
<footer><small>Generated at <span id="generated">${now.toISOString()}</span> request 000000000000 <span id="clock"></span></small></footer>
<script src="/app.js"></script></body></html>`;
}
