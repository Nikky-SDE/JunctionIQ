import express from "express";
import { EngineError } from "./services/engineClient.js";
import {
  handleHealth,
  handleRoutesSearch,
  handleStationByCode,
  handleStationsSearch,
} from "./services/apiHandlers.js";

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60_000;
  const max = options.max ?? 60;
  const requests = new Map();

  // Periodically sweep expired IP records to prevent memory leak
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of requests.entries()) {
      const active = timestamps.filter((t) => now - t < windowMs);
      if (active.length === 0) {
        requests.delete(ip);
      } else {
        requests.set(ip, active);
      }
    }
  }, Math.max(windowMs * 2, 60_000));
  if (interval.unref) interval.unref();

  return (req, res, next) => {
    if (max <= 0) return next();
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const timestamps = (requests.get(ip) || []).filter((t) => now - t < windowMs);

    if (timestamps.length >= max) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000).toString());
      return res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: "Too many route search requests. Please slow down.",
        },
      });
    }

    timestamps.push(now);
    requests.set(ip, timestamps);
    next();
  };
}

export function createApp({ stations, routes, engine, corsOrigin, rateLimitOptions }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "16kb" }));

  // Baseline security headers & request timing logger
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    const start = performance.now();
    res.on("finish", () => {
      const ms = Math.round((performance.now() - start) * 100) / 100;
      console.log(`${req.method} ${req.path} ${res.statusCode} - ${ms}ms`);
    });
    if (corsOrigin) {
      res.setHeader("access-control-allow-origin", corsOrigin);
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      if (req.method === "OPTIONS") return res.sendStatus(204);
    }
    next();
  });

  const health = async (_req, res) => {
    const out = await handleHealth({ stations, engine, uptimeSeconds: process.uptime() });
    res.status(out.status).json(out.body);
  };
  app.get("/health", health);
  app.get("/api/health", health);

  app.get("/api/stations", (req, res) => {
    const out = handleStationsSearch({ stations, query: req.query });
    res.status(out.status).json(out.body);
  });

  app.get("/api/stations/:code", (req, res) => {
    const out = handleStationByCode({ stations, code: req.params.code });
    res.status(out.status).json(out.body);
  });

  const routesRateLimiter = createRateLimiter(rateLimitOptions);

  app.post("/api/routes", routesRateLimiter, async (req, res, next) => {
    try {
      const out = await handleRoutesSearch({ stations, routes, body: req.body });
      res.status(out.status).json(out.body);
    } catch (e) {
      next(e);
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "route not found" } });
  });

  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed" || (err instanceof SyntaxError && err.status === 400)) {
      return res.status(400).json({ error: { code: "INVALID_JSON", message: "request body must be valid JSON" } });
    }
    if (err?.type === "entity.too.large" || err?.status === 413) {
      return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "request body exceeds size limit" } });
    }
    if (err instanceof EngineError) {
      const status = err.kind === "invalid" ? 400 : err.kind === "overloaded" ? 429 : 503;
      return res.status(status).json({ error: { code: "ENGINE_ERROR", message: err.message } });
    }
    console.error("Unhandled error:", err);
    res.status(500).json({ error: { code: "INTERNAL", message: "internal server error" } });
  });

  return app;
}
