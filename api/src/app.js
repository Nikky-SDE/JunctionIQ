import express from "express";
import { EngineError } from "./services/engineClient.js";
import {
  handleHealth,
  handleRoutesSearch,
  handleStationByCode,
  handleStationsSearch,
} from "./services/apiHandlers.js";

export function createApp({ stations, routes, engine, corsOrigin }) {
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

  app.post("/api/routes", async (req, res, next) => {
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
