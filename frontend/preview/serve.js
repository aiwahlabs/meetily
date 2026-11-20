// AIWAH preview server: serves the static export (./out) in a normal browser with sample
// data, so UI changes can be reviewed before building an installer.
//   pnpm preview            -> builds the UI, then serves http://127.0.0.1:4310
//   pnpm preview:serve      -> serves the last build without rebuilding
// States: /?mock=signedout  /?mock=onboarding  /floating?mock=pop-adhoc|pop-calendar|pop-recording|pop-saved
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(process.argv[2] || "out");
const port = Number(process.argv[3] || 4310);
const mock = fs.readFileSync(path.join(__dirname, "mock.js"));
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon", ".txt": "text/plain",
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/__mock.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
      return res.end(mock);
    }
    const file = path.join(root, url);
    const hit = [file, file + ".html", path.join(file, "index.html")].find(
      (c) => c.startsWith(root) && fs.existsSync(c) && fs.statSync(c).isFile(),
    );
    if (!hit) {
      res.writeHead(404);
      return res.end("not found");
    }
    const type = types[path.extname(hit)] || "application/octet-stream";
    if (path.extname(hit) === ".html") {
      const html = fs.readFileSync(hit, "utf8").replace("<head>", '<head><script src="/__mock.js"></script>');
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      return res.end(html);
    }
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(hit).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`Aiwah Minutes UI preview (sample data): http://127.0.0.1:${port}`));
