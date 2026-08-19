import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("C:/tmp/uniaccess-onorca-build");
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

http.createServer(async (request, response) => {
  const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^[/\\]+/, "");
  let target = path.resolve(root, relative);

  if (!target.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    if ((await stat(target)).isDirectory()) target = path.join(target, "index.html");
  } catch {
    target = path.join(root, "index.html");
  }

  try {
    const body = await readFile(target);
    response.writeHead(200, {
      "Content-Type": mime[path.extname(target)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(4173, "127.0.0.1");
