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

const routes = [["today", "#/today"], ["families", "#/families"], ["family", "#/families/fb"], ["money", "#/money"], ["staff", "#/staff"]];
const sizes = [["phone", 390, 844], ["desktop", 1280, 860]];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const [sname, w, h] of sizes) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  for (const [name, hash] of routes) {
    await page.goto(`http://localhost:4173/${hash}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, `${name}-${sname}.png`), fullPage: true });
  }
  if (errors.length) console.log(sname, "console errors:", errors);
  await ctx.close();
}
await browser.close();
server.close();
console.log("done", out);
