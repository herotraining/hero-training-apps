import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
const dist = "dist";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  let p = join(dist, (req.url ?? "/").split("?")[0]);
  try { if ((await stat(p)).isDirectory()) p = join(p, "index.html"); } catch { p = join(dist, "index.html"); }
  try { res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream" }); res.end(await readFile(p)); } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(4176, r));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("dialog", (d) => d.accept());
await page.goto("http://localhost:4176/#/today", { waitUntil: "networkidle" });
await page.waitForSelector(".roster");
const segs = await page.$$(".seg");
await segs[0].$eval("button:nth-child(1)", (b) => b.click());
await segs[1].$eval("button:nth-child(2)", (b) => b.click());
await page.waitForSelector("text=1 here, 1 out of 3");
// toggle off again
await segs[0].$eval("button:nth-child(1)", (b) => b.click());
await page.waitForSelector("text=0 here, 1 out of 3");
// closure
await page.click("text=Add a closure");
await page.fill("#title", "Veterans Day: no classes");
await page.fill("#on_date", "2026-11-11");
await page.click("dialog[open] button:text-is('Save')");
await page.waitForSelector("text=Veterans Day");
await page.screenshot({ path: "shots/ops-today.png", fullPage: true });
// program
await page.goto("http://localhost:4176/#/programs", { waitUntil: "networkidle" });
await page.click("text=Add a program");
await page.fill("#name", "Saturday Open Gym, Peoria");
await page.selectOption("#weekday", "6");
await page.fill("#price", "60");
await page.click("dialog[open] button:text-is('Add program')");
await page.waitForSelector("text=Saturday Open Gym");
await page.click("li:has-text('Saturday Open Gym') >> button:text-is('Edit')");
await page.screenshot({ path: "shots/ops-program-edit.png", fullPage: true });
console.log("errors:", errs);
await browser.close(); server.close();
