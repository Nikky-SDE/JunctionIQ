import { readFileSync } from "node:fs";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpRoutingEngine, HybridRoutingEngine } from "./services/engineClient.js";
import { JourneyRenderer } from "./services/journeyRenderer.js";
import { JsRoutingEngine } from "./services/jsEngine.js";
import { RouteService } from "./services/routeService.js";
import { loadStationsFromFile, StationService } from "./services/stationService.js";

const config = loadConfig();

console.log("Starting Junction IQ API server...");

// load stations
const stations = new StationService();
stations.load(await loadStationsFromFile(config.stationsFile), "file");
console.log(`Loaded ${stations.size} stations from ${config.stationsFile}`);

// load timetable buffer once for both renderer and in-process JS engine
const timetableBytes = readFileSync(config.timetablePath);
const renderer = new JourneyRenderer(timetableBytes);
const jsEngine = config.engineMode === "http" ? null : new JsRoutingEngine(timetableBytes);
console.log(`Loaded timetable from ${config.timetablePath} (hash: ${renderer.hash})`);

// setup engine & route services
const httpEngine = config.engineMode === "js" ? null : new HttpRoutingEngine(config.engineUrl);
const engine = new HybridRoutingEngine(httpEngine, jsEngine, config.engineMode);
const routes = new RouteService(engine, stations, renderer, config.maxResults);

const app = createApp({
  stations,
  routes,
  engine,
  corsOrigin: config.corsOrigin,
});

const server = app.listen(config.port, config.host, () => {
  console.log(`API listening on http://${config.host}:${config.port} (engine mode: ${config.engineMode})`);
});

server.keepAliveTimeout = 65_000;

const shutdown = (signal) => {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
