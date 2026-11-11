export default {
  match: { method: "POST", path: "/api/patients/{id}/notes" },
  kind: "write",
  handle(ctx) {
    const text = String(ctx.json?.text ?? "").trim();
    if (!text) return ctx.json_(422, { error: "text required" });
    const patient = Number(ctx.params[0]);
    const { lastInsertRowid } = ctx.db.run(
      "insert into note (patient, text, author) values (?, ?, 'dr.test')",
      patient,
      text,
    );
    return ctx.json_(201, { id: lastInsertRowid, patient, text, author: "dr.test" });
  },
};
