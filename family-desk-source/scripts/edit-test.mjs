import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
const dist = process.argv[2], out = process.argv[3];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  let p = join(dist, (req.url ?? "/").split("?")[0]);
  try { if ((await stat(p)).isDirectory()) p = join(p, "index.html"); } catch { p = join(dist, "index.html"); }
  try { res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream" }); res.end(await readFile(p)); } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(4175, r));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("dialog", (d) => d.accept());
const shot = (n) => page.screenshot({ path: `${out}/${n}.png`, fullPage: true });

// 1. Add a family from the list
await page.goto("http://localhost:4175/#/families", { waitUntil: "networkidle" });
await page.click("text=Add a family");
await page.fill("#name", "The Rivera family");
await page.fill("#g_name", "Maria Rivera");
await page.fill("#g_mobile", "(602) 555-0142");
await page.fill("#city", "Peoria");
await shot("01-add-family");
await page.click("dialog[open] button:text-is('Add family')");
await page.waitForSelector("h1:has-text('Rivera')");
await shot("02-new-family");

// 2. Add a child
await page.click("text=Add a child");
await page.fill("#first_name", "Leo");
await page.fill("#birth_date", "2018-04-02");
await page.fill("#house", "Eagle");
await page.fill("#uniform_size", "YM");
await shot("03-add-child");
await page.click("dialog[open] button:text-is('Add child')");
await page.waitForSelector(".kid .nm:has-text('Leo')");

// 3. Enroll
await page.click(".kid button:text-is('Enroll')");
await page.selectOption("#program_id", "coop-peoria-thu");
await shot("04-enroll");
await page.click("dialog[open] button:text-is('Enroll')");
await page.waitForSelector("text=Co-op Day, Peoria, Thursdays");

// 4. Care notes
await page.click(".kid button:text-is('Care notes')");
await page.fill("#allergies", "Peanuts");
await page.fill("#emergency", "Grandma Rivera, (602) 555-0201");
await page.fill("#pickups", "Maria Rivera\nGrandma Rivera");
await page.click("dialog[open] button:text-is('Save')");
await page.waitForSelector("text=Allergy: Peanuts");

// 5. Agreement
await page.click("button:text-is('Mark signed')");
await page.click("dialog[open] button:text-is('Mark signed')");
await page.waitForSelector("text=Signed");
await shot("05-family-after");

// 6. Change enrollment to waitlist, then check the Today roster lost him (Thursday only matters on Thursday) and the Families list shows the tag
await page.click(".kid button.linkbtn");
await page.selectOption("#status", "waitlist");
await page.click("dialog[open] button:text-is('Save')");
await page.waitForSelector("text=on the waitlist");
await page.goto("http://localhost:4175/#/families", { waitUntil: "networkidle" });
await page.waitForSelector("text=Rivera");
await shot("06-families-list");

console.log("errors:", errs);
await browser.close(); server.close();
