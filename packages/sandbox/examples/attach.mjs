// Attach to the Chrome that `sandbox up` started and use the copy of the test app.
//   node packages/sandbox/examples/attach.mjs [devtools-address]
// In your own project this is all an agent framework needs: connect over CDP instead of launching a browser.
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(process.argv[2] ?? "http://127.0.0.1:9333");
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("http://127.0.0.1:4010/patients/102");
await page.waitForSelector("#notes li");
console.log("title:", await page.title(), "| notes:", await page.locator("#notes li").count());

const res = await page.goto("http://127.0.0.1:4010/patients/999");
console.log("a page that was never recorded:", res.status(), res.headers()["x-sandbox"]);

await browser.close(); // disconnects; the copy's Chrome keeps running
