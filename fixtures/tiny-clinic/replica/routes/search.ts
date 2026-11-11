export default {
  match: { method: "POST", path: "/api/search" },
  kind: "read",
  handle(ctx) {
    const q = `%${String(ctx.json?.q ?? "").toLowerCase()}%`;
    return ctx.json_(
      200,
      ctx.db.all("select id, first, last from patient where lower(first || ' ' || last) like ? order by id", q),
    );
  },
};
