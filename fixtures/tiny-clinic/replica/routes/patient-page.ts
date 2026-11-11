import { esc, page } from "../templates/page.ts";

export default {
  match: { method: "GET", path: "/patients/{id}" },
  kind: "read",
  handle(ctx) {
    const p = ctx.db.get("select * from patient where id = ?", Number(ctx.params[0]));
    if (!p) return ctx.html(404, page("Not found", "<p>No such patient.</p>", ctx.now()));
    return ctx.html(
      200,
      page(
        `${p.last}, ${p.first}`,
        `
<dl><dt>Date of birth</dt><dd id="dob">${esc(p.dob)}</dd><dt>Phone</dt><dd id="phone">${esc(p.phone)}</dd><dt>Chart</dt><dd id="signed">${p.signed ? "Signed" : "Not signed"}</dd></dl>
<p><a href="/patients/${p.id}/edit">Edit demographics</a></p>
<h2>Notes (<span id="note-count">0</span>)</h2><ul id="notes" data-patient="${p.id}"></ul>
<form id="add-note" data-patient="${p.id}"><label>New note <input name="text" required></label><button type="submit">Add note</button></form>
<p><button id="sign" data-patient="${p.id}">Sign and send chart</button></p>`,
        ctx.now(),
      ),
    );
  },
};
