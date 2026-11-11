import { esc, page } from "../templates/page.ts";

export default {
  match: { method: "GET", path: "/patients" },
  kind: "read",
  handle(ctx) {
    const rows = ctx.db.all("select * from patient order by id");
    const list = rows
      .map(
        (p) => `<li><a href="/patients/${p.id}">${esc(p.last)}, ${esc(p.first)}</a> <small>${esc(p.dob)}</small></li>`,
      )
      .join("");
    return ctx.html(200, page("Patients", `<ul id="patients">${list}</ul>`, ctx.now()));
  },
};
