export default {
  match: { method: "POST", path: "/patients/{id}/edit" },
  kind: "write",
  handle(ctx) {
    const id = Number(ctx.params[0]);
    const p = ctx.db.get("select * from patient where id = ?", id);
    if (!p) return ctx.html(404, "<p>No such patient.</p>");
    ctx.db.run(
      "update patient set first = ?, last = ?, phone = ? where id = ?",
      ctx.form.first ?? p.first,
      ctx.form.last ?? p.last,
      ctx.form.phone ?? p.phone,
      id,
    );
    return ctx.redirect(`/patients/${id}`);
  },
};
