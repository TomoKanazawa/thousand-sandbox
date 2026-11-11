export default {
  match: { method: "DELETE", path: "/api/notes/{id}" },
  kind: "write",
  handle(ctx) {
    const { changes } = ctx.db.run("delete from note where id = ?", Number(ctx.params[0]));
    return changes ? ctx.respond(204) : ctx.json_(404, { error: "no such note" });
  },
};
