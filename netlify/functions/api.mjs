import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleHealth,
  handleRoutesSearch,
  handleStationByCode,
  handleStationsSearch,
} from "../../api/src/services/apiHandlers.js";
import { JourneyRenderer } from "../../api/src/services/journeyRenderer.js";
import { JsRoutingEngine } from "../../api/src/services/jsEngine.js";
import { RouteService } from "../../api/src/services/routeService.js";
import { loadStationsFromFile, StationService } from "../../api/src/services/stationService.js";

function getModuleDir() {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    // ignore when bundled as CJS
  }
  if (typeof __dirname !== "undefined") return __dirname;
  return process.cwd();
}

const here = getModuleDir();
let runtimePromise = null;

function resolveDataFile(envName, relativePath) {
  if (process.env[envName] && existsSync(process.env[envName])) {
    return process.env[envName];
  }
  const candidates = [
    resolve(process.cwd(), relativePath),
    ...(process.env.LAMBDA_TASK_ROOT ? [resolve(process.env.LAMBDA_TASK_ROOT, relativePath)] : []),
    resolve(here, relativePath),
    resolve(here, "../", relativePath),
    resolve(here, "../../", relativePath),
    resolve(here, "../../../", relativePath),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate ${relativePath} (cwd=${process.cwd()}, here=${here})`);
}

async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const stationsFile = resolveDataFile("STATIONS_FILE", "data/processed/stations.json");
      const timetablePath = resolveDataFile("TIMETABLE_PATH", "data/processed/timetable.json");

      const stations = new StationService();
      stations.load(await loadStationsFromFile(stationsFile), "file");

      const renderer = JourneyRenderer.fromFile(timetablePath);
      const engine = JsRoutingEngine.fromFile(timetablePath);
      const maxResults = Number(process.env.MAX_RESULTS) || 50;
      const routes = new RouteService(engine, stations, renderer, maxResults);

      return { stations, engine, routes };
    })();
  }
  return runtimePromise;
}

function normalizePath(rawPath) {
  let p = rawPath || "/";
  if (p.startsWith("http://") || p.startsWith("https://")) {
    try {
      p = new URL(p).pathname;
    } catch {
      p = "/";
    }
  }
  p = p.split("?")[0];
  if (p.startsWith("/.netlify/functions/api")) {
    p = p.slice("/.netlify/functions/api".length) || "/";
  }
  if (!p.startsWith("/api") && p !== "/health") {
    p = `/api${p.startsWith("/") ? "" : "/"}${p}`;
  }
  return p;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  try {
    const method = (event.httpMethod || "GET").toUpperCase();
    const path = normalizePath(event.path || event.rawUrl);
    const { stations, engine, routes } = await getRuntime();

    if (method === "GET" && (path === "/health" || path === "/api/health")) {
      const out = await handleHealth({ stations, engine, uptimeSeconds: process.uptime() });
      return jsonResponse(out.status, out.body);
    }

    if (method === "GET" && path === "/api/stations") {
      const out = handleStationsSearch({ stations, query: event.queryStringParameters || {} });
      return jsonResponse(out.status, out.body);
    }

    if (method === "GET" && path.startsWith("/api/stations/")) {
      const code = decodeURIComponent(path.slice("/api/stations/".length));
      const out = handleStationByCode({ stations, code });
      return jsonResponse(out.status, out.body);
    }

    if (method === "POST" && path === "/api/routes") {
      let body = {};
      if (event.body) {
        try {
          const raw = event.isBase64Encoded
            ? Buffer.from(event.body, "base64").toString("utf8")
            : event.body;
          body = JSON.parse(raw);
        } catch {
          return jsonResponse(400, { error: { code: "INVALID_JSON", message: "request body must be valid JSON" } });
        }
      }
      const out = await handleRoutesSearch({ stations, routes, body });
      return jsonResponse(out.status, out.body);
    }

    return jsonResponse(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  } catch (err) {
    console.error("Netlify API handler error:", err);
    return jsonResponse(500, { error: { code: "INTERNAL", message: "internal server error" } });
  }
}
