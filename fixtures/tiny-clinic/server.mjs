// tiny-clinic: a small fictional EHR used to test the sandbox tool.
// Server-rendered pages + JSON API + CSRF + cookies + a non-GET read + volatile values + a beacon + WebSocket.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";

const SEED = () => ({
  patients: [
    { id: 101, first: "Ada", last: "Marlow", dob: "1961-03-14", phone: "555-0101", signed: false },
    { id: 102, first: "Ben", last: "Okafor", dob: "1978-11-02", phone: "555-0102", signed: false },
    { id: 103, first: "Cleo", last: "Tanaka", dob: "1990-07-23", phone: "555-0103", signed: false },
    { id: 104, first: "Dev", last: "Rossi", dob: "1955-01-30", phone: "555-0104", signed: false },
  ],
  notes: [
    { id: 1, patient: 101, text: "Follow-up in two weeks.", author: "dr.test" },
    { id: 2, patient: 101, text: "Blood pressure stable.", author: "dr.test" },
    { id: 3, patient: 102, text: "New patient intake.", author: "dr.test" },
    { id: 4, patient: 103, text: "Refill requested.", author: "dr.test" },
  ],
  nextNote: 5,
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const APP_JS = `
const csrf = document.querySelector('meta[name=csrf]')?.content;
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-csrf': csrf }, body: body ? JSON.stringify(body) : undefined });
  return r.status === 204 ? null : r.json();
}
async function loadNotes() {
  const el = document.getElementById('notes'); if (!el) return;
  const pid = el.dataset.patient;
  const notes = await api('GET', '/api/patients/' + pid + '/notes?_=' + Date.now());
  el.innerHTML = notes.map(n => '<li data-id="' + n.id + '"><span>' + n.text.replace(/</g,'&lt;') + '</span> <button class="del" aria-label="Delete note ' + n.id + '">Delete note</button></li>').join('') || '<li class="empty">No notes</li>';
  document.getElementById('note-count').textContent = notes.length;
}
document.addEventListener('click', async (e) => {
  if (e.target.matches('.del')) { await api('DELETE', '/api/notes/' + e.target.closest('li').dataset.id); loadNotes(); }
  if (e.target.id === 'sign') { const r = await api('POST', '/api/patients/' + e.target.dataset.patient + '/sign'); document.getElementById('signed').textContent = r.signed ? 'Signed' : 'Not signed'; }
});
document.addEventListener('submit', async (e) => {
  if (e.target.id === 'add-note') { e.preventDefault(); const t = e.target.querySelector('[name=text]'); await api('POST', '/api/patients/' + e.target.dataset.patient + '/notes', { text: t.value }); t.value = ''; loadNotes(); }
  if (e.target.id === 'search') { e.preventDefault(); const q = e.target.querySelector('[name=q]').value; const rows = await api('POST', '/api/search', { q }); document.getElementById('results').innerHTML = rows.map(p => '<li><a href="/patients/' + p.id + '">' + p.last + ', ' + p.first + '</a></li>').join(''); }
});
loadNotes();
navigator.sendBeacon && navigator.sendBeacon('/beacon', JSON.stringify({ page: location.pathname, t: Date.now() }));
try { const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); ws.onmessage = (m) => { const el = document.getElementById('clock'); if (el) el.textContent = m.data; }; } catch {}
`;
const CSS =
  "body{font:15px system-ui;margin:2rem;max-width:720px}nav a{margin-right:1rem}li{margin:.3rem 0}button{margin-left:.5rem}";

export function startTinyClinic(port = 0) {
  let db = SEED();
  let variant = "v1"; // "v2" simulates a release of the app: a renamed button and a changed API
  const sessions = new Map(); // sid -> { user, csrf }

  const page = (
    sess,
    title,
    body,
  ) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - Tiny Clinic</title>
<meta name="csrf" content="${sess?.csrf ?? ""}"><link rel="stylesheet" href="/style.css"></head><body>
<nav><a href="/patients">Patients</a><a href="/search">Search</a><a href="/logout">Log out</a></nav>
<h1>${esc(title)}</h1>
${body}
<footer><small>Generated at <span id="generated">${new Date().toISOString()}</span> request ${randomBytes(6).toString("hex")} <span id="clock"></span></small></footer>
<script src="/app.js"></script></body></html>`;

  const readBody = (req) =>
    new Promise((res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    // Test switches, for whoever is trying the sandbox tool. They are not part of the "app" and need no login.
    //   GET  /__test/state        the real app's data, to prove a crawl changed nothing
    //   POST /__test/reset        put the data back
    //   POST /__test/variant/v2   release a changed version (renamed button, changed API); /v1 goes back
    if (path.startsWith("/__test/")) {
      const m = /^\/__test\/variant\/(v1|v2)$/.exec(path);
      if (m && req.method === "POST") variant = m[1];
      else if (path === "/__test/reset" && req.method === "POST") db = SEED();
      else if (path !== "/__test/state") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ variant, ...db }));
      return;
    }
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "cache-control": "no-store", ...headers });
      res.end(body);
    };
    const html = (status, body, headers = {}) =>
      send(status, body, { "content-type": "text/html; charset=utf-8", ...headers });
    const json = (status, obj) => send(status, JSON.stringify(obj), { "content-type": "application/json" });
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const sess = sid ? sessions.get(sid) : undefined;
    const body = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method) ? await readBody(req) : "";

    if (path === "/style.css") return send(200, CSS, { "content-type": "text/css", "cache-control": "max-age=3600" });
    if (path === "/app.js")
      return send(200, APP_JS, { "content-type": "application/javascript", "cache-control": "max-age=3600" });
    if (path === "/beacon") return send(204, "");
    if (path === "/__reset" && req.method === "POST") {
      db = SEED();
      return json(200, { ok: true });
    }
    if (path === "/__state") return json(200, db);

    if (path === "/login" && req.method === "GET") {
      const pre = randomBytes(8).toString("hex");
      return html(
        200,
        `<!doctype html><html><head><meta charset="utf-8"><title>Log in - Tiny Clinic</title><link rel="stylesheet" href="/style.css"></head><body><h1>Tiny Clinic</h1>
<form method="post" action="/login"><input type="hidden" name="pre" value="${pre}">
<label>User <input name="user" autocomplete="username"></label>
<label>Password <input name="password" type="password"></label>
<button type="submit">Log in</button></form></body></html>`,
      );
    }
    if (path === "/login" && req.method === "POST") {
      const f = new URLSearchParams(body);
      if (!f.get("user") || f.get("password") !== "test-password")
        return html(401, "<p>Wrong user or password. <a href='/login'>Back</a></p>");
      const id = randomBytes(12).toString("hex");
      sessions.set(id, { user: f.get("user"), csrf: randomBytes(12).toString("hex") });
      return send(302, "", { location: "/patients", "set-cookie": `sid=${id}; Path=/; HttpOnly` });
    }
    if (path === "/logout") {
      if (sid) sessions.delete(sid);
      return send(302, "", { location: "/login", "set-cookie": "sid=; Path=/; Max-Age=0" });
    }
    if (!sess)
      return path.startsWith("/api/") ? json(401, { error: "login required" }) : send(302, "", { location: "/login" });

    if (req.method !== "GET" && path.startsWith("/api/") && req.headers["x-csrf"] !== sess.csrf)
      return json(403, { error: "bad csrf" });

    if (path === "/") return send(302, "", { location: "/patients" });
    if (path === "/patients" && req.method === "GET")
      return html(
        200,
        page(
          sess,
          "Patients",
          `<ul id="patients">${db.patients.map((p) => `<li><a href="/patients/${p.id}">${esc(p.last)}, ${esc(p.first)}</a> <small>${esc(p.dob)}</small></li>`).join("")}</ul>`,
        ),
      );
    if (path === "/search" && req.method === "GET")
      return html(
        200,
        page(
          sess,
          "Search",
          `<form id="search"><label>Name <input name="q"></label><button type="submit">Search</button></form><ul id="results"></ul>`,
        ),
      );

    let m;
    if ((m = /^\/patients\/(\d+)$/.exec(path)) && req.method === "GET") {
      const p = db.patients.find((x) => x.id === Number(m[1]));
      if (!p) return html(404, page(sess, "Not found", "<p>No such patient.</p>"));
      return html(
        200,
        page(
          sess,
          `${p.last}, ${p.first}`,
          `
<dl><dt>Date of birth</dt><dd id="dob">${esc(p.dob)}</dd><dt>Phone</dt><dd id="phone">${esc(p.phone)}</dd><dt>Chart</dt><dd id="signed">${p.signed ? "Signed" : "Not signed"}</dd></dl>
<p><a href="/patients/${p.id}/edit">Edit demographics</a></p>
<h2>Notes (<span id="note-count">0</span>)</h2><ul id="notes" data-patient="${p.id}"></ul>
<form id="add-note" data-patient="${p.id}"><label>New note <input name="text" required></label><button type="submit">${variant === "v2" ? "Create note" : "Add note"}</button></form>
<p><button id="sign" data-patient="${p.id}">Sign and send chart</button></p>`,
        ),
      );
    }
    if ((m = /^\/patients\/(\d+)\/edit$/.exec(path))) {
      const p = db.patients.find((x) => x.id === Number(m[1]));
      if (!p) return html(404, page(sess, "Not found", "<p>No such patient.</p>"));
      if (req.method === "GET")
        return html(
          200,
          page(
            sess,
            `Edit ${p.last}, ${p.first}`,
            `<form method="post" action="/patients/${p.id}/edit"><input type="hidden" name="csrf" value="${sess.csrf}">
<label>First <input name="first" value="${esc(p.first)}"></label><label>Last <input name="last" value="${esc(p.last)}"></label>
<label>Phone <input name="phone" value="${esc(p.phone)}"></label><button type="submit">Save changes</button></form>`,
          ),
        );
      const f = new URLSearchParams(body);
      if (f.get("csrf") !== sess.csrf) return html(403, "<p>Bad token</p>");
      p.first = f.get("first") ?? p.first;
      p.last = f.get("last") ?? p.last;
      p.phone = f.get("phone") ?? p.phone;
      return send(302, "", { location: `/patients/${p.id}` });
    }
    if (path === "/api/time") return json(200, { now: Date.now() });
    if (path === "/api/patients" && req.method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return json(
        200,
        db.patients.filter((p) => `${p.first} ${p.last}`.toLowerCase().includes(q)),
      );
    }
    if (path === "/api/search" && req.method === "POST") {
      const q = String(JSON.parse(body || "{}").q ?? "").toLowerCase();
      return json(
        200,
        db.patients
          .filter((p) => `${p.first} ${p.last}`.toLowerCase().includes(q))
          .map(({ id, first, last }) => ({ id, first, last })),
      );
    }
    if ((m = /^\/api\/patients\/(\d+)\/notes$/.exec(path))) {
      const pid = Number(m[1]);
      if (req.method === "GET")
        return json(
          200,
          db.notes
            .filter((n) => n.patient === pid)
            .map((n) => (variant === "v2" ? { id: n.id, patient: n.patient, text: n.text, created: "2026-01-01" } : n)),
        );
      if (req.method === "POST") {
        const text = String(JSON.parse(body || "{}").text ?? "").trim();
        if (!text) return json(422, { error: "text required" });
        const note = { id: db.nextNote++, patient: pid, text, author: sess.user };
        db.notes.push(note);
        return json(201, note);
      }
    }
    if ((m = /^\/api\/notes\/(\d+)$/.exec(path)) && req.method === "DELETE") {
      const before = db.notes.length;
      db.notes = db.notes.filter((n) => n.id !== Number(m[1]));
      return before === db.notes.length ? json(404, { error: "no such note" }) : send(204, "");
    }
    if ((m = /^\/api\/patients\/(\d+)\/sign$/.exec(path)) && req.method === "POST") {
      const p = db.patients.find((x) => x.id === Number(m[1]));
      if (!p) return json(404, { error: "no such patient" });
      p.signed = true;
      return json(200, { signed: true });
    }
    return path.startsWith("/api/")
      ? json(404, { error: "not found" })
      : html(404, page(sess, "Not found", "<p>Nothing here.</p>"));
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    ws.send(new Date().toISOString());
    const t = setInterval(() => ws.readyState === 1 && ws.send(new Date().toISOString()), 1000);
    ws.on("close", () => clearInterval(t));
  });

  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        state: () => db,
        reset: () => {
          db = SEED();
        },
        setVariant: (v) => {
          variant = v;
        },
        dropSessions: () => sessions.clear(),
        close: () =>
          new Promise((r) => {
            wss.close();
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      }),
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startTinyClinic(Number(process.env.PORT ?? 4010));
  console.log(`tiny-clinic on ${s.url}  (any user, password "test-password")`);
}
