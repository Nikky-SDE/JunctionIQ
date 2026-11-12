import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "dist");
const DIST_PREFIX = DIST_DIR.endsWith(path.sep) ? DIST_DIR : DIST_DIR + path.sep;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_PROXY_BODY_BYTES = 32 * 1024;
const target = () => (process.env.API_INTERNAL_URL || "http://127.0.0.1:4000").replace(/\/$/, "");

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
};

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://server.arcgisonline.com; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
}

async function handleApiProxy(req, res) {
  const url = `${target()}${req.url}`;
  try {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key !== "host" && !HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        headers[key] = value;
      }
    }
    if (!headers["x-request-id"]) {
      headers["x-request-id"] = crypto.randomUUID();
    }

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_PROXY_BODY_BYTES) {
        res.statusCode = 413;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 32 KB limit." } }));
        return;
      }
      chunks.push(chunk);
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const upstreamRes = await fetch(url, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    res.statusCode = upstreamRes.status;
    upstreamRes.headers.forEach((v, k) => {
      if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    });

    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { code: "API_UNAVAILABLE", message: "The routing service is unavailable. Please try again." } }));
  }
}

function handleStatic(req, res) {
  let pathname;
  try {
    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    pathname = decodeURIComponent(parsedUrl.pathname);
  } catch {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  let filePath = path.resolve(DIST_DIR, `.${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_PREFIX)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  let stats;
  try {
    stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stats = fs.statSync(filePath);
    }
  } catch {
    filePath = path.join(DIST_DIR, "index.html");
    try {
      stats = fs.statSync(filePath);
    } catch {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  if (pathname.startsWith("/assets/")) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  applySecurityHeaders(res);
  if (req.url?.startsWith("/api/") || req.url === "/health") {
    handleApiProxy(req, res);
  } else {
    handleStatic(req, res);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Frontend production server listening on http://${HOST}:${PORT}`);
});
