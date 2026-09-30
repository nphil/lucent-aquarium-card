/** Static server for the dev harness: `bun frontend/dev/serve.mjs` (HARNESS_PORT, default 4180). */
import { extname, join, normalize, sep } from "node:path";

const ROOT = import.meta.dir;
const PORT = Number(process.env.HARNESS_PORT ?? 4180);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(request) {
    let path;
    try {
      path = normalize(decodeURIComponent(new URL(request.url).pathname));
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (path === sep || path === "") path = "/index.html";
    const filePath = join(ROOT, path);
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, { headers: { "content-type": TYPES[extname(filePath)] ?? "application/octet-stream", "cache-control": "no-store" } });
  },
});

console.log(`aquarium-light-card dev harness: http://127.0.0.1:${PORT}/`);
