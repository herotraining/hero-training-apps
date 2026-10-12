// Screenshots of the built demo-data app (VITE_MOCK=1) at phone and desktop widths.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const out = new URL("../shots/", import.meta.url).pathname;
await mkdir(out, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  let p = join(dist, (req.url ?? "/").split("?")[0].split("#")[0]);
  try { if ((await stat(p)).isDirectory()) p = join(p, "index.html"); } catch { p = join(dist, "index.html"); }
  try { res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream" }); res.end(await readFile(p)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(4173, r));

const routes = [["today", "#/today"], ["families", "#/families"], ["family", "#/families/fb"], ["family-a", "#/families/fa"], ["money", "#/money"], ["staff", "#/staff"], ["staff-pay", "#/staff", "text=Show"], ["programs", "#/programs"],
  ["store", "#/store"], ["store-add", "#/store/fa", ".tile:has-text('HERO uniform T-shirt')"],
  ["store-cart", "#/store/fa", [".tile:has-text('HERO uniform T-shirt')", "dialog button:has-text('Navy')", "text=Add $25"]],
  ["store-pay", "#/store/fa", [".tile:has-text('HERO uniform T-shirt')", "dialog button:has-text('Navy')", "text=Add $25", "button:has-text('Check out'):visible", "text=Choose how to pay"]],
  ["store-qr", "#/store", [".tile:has-text('Extra HERO T-shirt')", "dialog button:has-text('Adult M')", "text=Add $15", "button:has-text('Check out'):visible", "text=Choose how to pay", "text=Card: show a QR code"]],
  ["store-item", "#/store", "text=Add an item"],
  ["store-fill", "#/store", "button:has-text('Fill it') >> nth=0"],
  ["request", "#/request"],
  ["request-pick", "#/request", [["fill", "#rq-email", "test.family.a@example.com"], ["fill", "#rq-first", "Avery"], "text=Continue", ".tile:has-text('HERO uniform tank top')"]],
  ["request-cart", "#/request", [["fill", "#rq-email", "test.family.a@example.com"], ["fill", "#rq-first", "Avery"], "text=Continue", ".tile:has-text('HERO uniform tank top')", "button:has-text('Navy')", "button:has-text('Youth M')", "text=Add it"]]];
const sizes = [["phone", 390, 844], ["desktop", 1280, 860]];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const [sname, w, h] of sizes) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  for (const [name, hash, click] of routes) {
    await page.goto("about:blank"); // a fresh app each time, so a dialog left open can't carry over
    await page.goto(`http://localhost:4173/${hash}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    for (const c of [click].flat().filter(Boolean)) {
      if (Array.isArray(c)) await page.fill(c[1], c[2]); else await page.click(c);
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: join(out, `${name}-${sname}.png`), fullPage: true });
  }
  if (errors.length) console.log(sname, "console errors:", errors);
  await ctx.close();
}
await browser.close();
server.close();
console.log("done", out);
