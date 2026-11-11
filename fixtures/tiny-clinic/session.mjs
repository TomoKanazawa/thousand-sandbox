// A recording session for the test app, for `sandbox capture --script fixtures/tiny-clinic/session.mjs`.
// It logs in, reads four patients, and makes each kind of change once: add a note, delete it, edit a phone number,
// run a search. Use it as a template for your own app: the function receives a Playwright page already open at the
// app's start URL.
export default async function session(page) {
  // Log in, unless the saved session from an earlier capture is still valid.
  if (await page.locator("input[name=password]").count()) {
    await page.fill("input[name=user]", "dr.test");
    await page.fill("input[name=password]", "test-password");
    await page.click("button[type=submit]");
  }
  await page.waitForURL("**/patients");

  for (const id of [101, 102, 103, 104]) {
    await page.goto(new URL(`/patients/${id}`, page.url()).href);
    await page.waitForSelector("#notes li");
    if (id === 101) await page.waitForTimeout(900); // pause like a person, so a settled snapshot is taken
  }

  await page.goto(new URL("/patients/102", page.url()).href);
  await page.waitForSelector("#notes li");
  await page.fill("#add-note input[name=text]", "Recorded by the capture script.");
  await page.click("#add-note button");
  await page.waitForFunction(() => document.querySelectorAll("#notes li[data-id]").length === 2);
  await page.click("#notes li:last-child .del");
  await page.waitForFunction(() => document.querySelectorAll("#notes li[data-id]").length === 1);

  await page.click("text=Edit demographics");
  await page.fill("input[name=phone]", "555-0199");
  await page.click("text=Save changes");
  await page.waitForURL("**/patients/102");
  await page.waitForSelector("#notes li");

  await page.goto(new URL("/search", page.url()).href);
  await page.fill("#search input[name=q]", "ta");
  await page.click("#search button");
  await page.waitForSelector("#results li");
  await page.goto(new URL("/patients", page.url()).href);
}
