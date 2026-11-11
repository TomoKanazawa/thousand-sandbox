export default {
  match: { method: "GET", path: "/api/patients/{id}/notes" },
  kind: "read",
  handle(ctx) {
    return ctx.json_(
      200,
      ctx.db.all("select id, patient, text, author from note where patient = ? order by id", Number(ctx.params[0])),
    );
  },
};
