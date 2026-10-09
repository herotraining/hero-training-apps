import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
const dist = process.argv[2];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  let p = join(dist, (req.url ?? "/").split("?")[0]);
  try { if ((await stat(p)).isDirectory()) p = join(p, "index.html"); } catch { p = join(dist, "index.html"); }
  try { res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream" }); res.end(await readFile(p)); } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(4174, r));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
await page.goto("http://localhost:4174/", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: process.argv[3], fullPage: true });
console.log("errors:", errs);
await browser.close(); server.close();
