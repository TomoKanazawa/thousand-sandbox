// Add a note to a patient in the copy of the test app, to show that a stateful copy keeps what is written.
//   node packages/sandbox/examples/write-note.mjs [devtools-address]
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(process.argv[2] ?? "http://127.0.0.1:9333");
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("http://127.0.0.1:4010/patients/103");
await page.waitForSelector("#notes li");
const before = await page.locator("#notes li[data-id]").count();
await page.fill("#add-note input[name=text]", "Written by an agent in the copy.");
await page.click("#add-note button");
await page.waitForFunction((n) => document.querySelectorAll("#notes li[data-id]").length === n + 1, before);
console.log("notes before", before, "after", await page.locator("#notes li[data-id]").count());

await browser.close();
