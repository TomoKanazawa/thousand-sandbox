import { esc, page } from "../templates/page.ts";

export default {
  match: { method: "GET", path: "/patients/{id}/edit" },
  kind: "read",
  handle(ctx) {
    const p = ctx.db.get("select * from patient where id = ?", Number(ctx.params[0]));
    if (!p) return ctx.html(404, page("Not found", "<p>No such patient.</p>", ctx.now()));
    return ctx.html(
      200,
      page(
        `Edit ${p.last}, ${p.first}`,
        `<form method="post" action="/patients/${p.id}/edit"><input type="hidden" name="csrf" value="SBX_CSRF_1">
<label>First <input name="first" value="${esc(p.first)}"></label><label>Last <input name="last" value="${esc(p.last)}"></label>
<label>Phone <input name="phone" value="${esc(p.phone)}"></label><button type="submit">Save changes</button></form>`,
        ctx.now(),
      ),
    );
  },
};
