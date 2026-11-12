import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  handleHealth,
  handleRoutesSearch,
  handleStationByCode,
  handleStationsSearch,
} from "../src/services/apiHandlers.js";
import { createApp } from "../src/app.js";
import { EngineError, HttpRoutingEngine, HybridRoutingEngine } from "../src/services/engineClient.js";
import { JourneyRenderer } from "../src/services/journeyRenderer.js";
import { JsRoutingEngine } from "../src/services/jsEngine.js";
import { RouteService } from "../src/services/routeService.js";
import { loadStationsFromFile, StationService } from "../src/services/stationService.js";

const here = dirname(fileURLToPath(import.meta.url));
const stationsFile = resolve(here, "../../data/processed/stations.json");
const timetablePath = resolve(here, "../../data/processed/timetable.json");

const stations = new StationService();
stations.load(await loadStationsFromFile(stationsFile), "file");
const renderer = JourneyRenderer.fromFile(timetablePath);
const jsEngine = JsRoutingEngine.fromFile(timetablePath);
const routes = new RouteService(jsEngine, stations, renderer, 50);

test("Station Search: city aliases resolve correctly", () => {
  const testCases = [
    { query: "CHENNAI", expectedCode: "MAS" },
    { query: "MADRAS", expectedCode: "MAS" },
    { query: "BOMBAY", expectedCode: "CSMT" },
    { query: "CALCUTTA", expectedCode: "HWH" },
    { query: "KOLKATA", expectedCode: "HWH" },
    { query: "BANGALORE", expectedCode: "SBC" },
    { query: "DELHI", expectedCode: "NDLS" },
    { query: "VARANASI", expectedCode: "BSB" },
    { query: "PRAYAGRAJ", expectedCode: "PRYJ" },
    { query: "ALLAHABAD", expectedCode: "PRYJ" },
  ];

  for (const tc of testCases) {
    const res = handleStationsSearch({ stations, query: { q: tc.query, limit: 10 } });
    assert.equal(res.status, 200);
    const codes = res.body.stations.map((s) => s.code);
    assert.ok(
      codes.includes(tc.expectedCode),
      `Query "${tc.query}" must include station ${tc.expectedCode}, got: ${codes.join(", ")}`
    );
  }
});

test("Route Input Validation: rejects invalid calendar dates and malformed queries", async () => {
  // February 31 is invalid calendar date
  const feb31 = await handleRoutesSearch({
    stations,
    routes,
    body: { source: "NDLS", destination: "MMCT", date: "2026-02-31", time: "08:00" },
  });
  assert.equal(feb31.status, 400);
  assert.equal(feb31.body.error.code, "VALIDATION_ERROR");

  // November 31 is invalid calendar date
  const nov31 = await handleRoutesSearch({
    stations,
    routes,
    body: { source: "NDLS", destination: "MMCT", date: "2026-11-31", time: "08:00" },
  });
  assert.equal(nov31.status, 400);
  assert.equal(nov31.body.error.code, "VALIDATION_ERROR");

  // Invalid time (25:00)
  const badTime = await handleRoutesSearch({
    stations,
    routes,
    body: { source: "NDLS", destination: "MMCT", date: "2026-11-15", time: "25:00" },
  });
  assert.equal(badTime.status, 400);

  // Missing date
  const missingDate = await handleRoutesSearch({
    stations,
    routes,
    body: { source: "NDLS", destination: "MMCT", time: "08:00" },
  });
  assert.equal(missingDate.status, 400);
});

test("Direct & Multi-transfer Routing: chronological validity and 30-min transfer buffer", async () => {
  const res = await handleRoutesSearch({
    stations,
    routes,
    body: { source: "HWH", destination: "MAS", date: "2026-11-15", time: "06:00", limit: 50 },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.routes.length > 0, "must find journeys between HWH and MAS");

  for (const route of res.body.routes) {
    const depTime = Date.parse(route.departure_datetime);
    const arrTime = Date.parse(route.arrival_datetime);
    assert.ok(arrTime > depTime, "Arrival must be strictly after departure");
    assert.equal(
      route.duration_minutes,
      (arrTime - depTime) / 60_000,
      "Duration minutes must match arrival minus departure"
    );

    // Verify legs chronology and transfer buffer
    for (let i = 0; i < route.segments.length; i++) {
      const seg = route.segments[i];
      const segDep = Date.parse(seg.departure_datetime);
      const segArr = Date.parse(seg.arrival_datetime);
      assert.ok(segArr > segDep, `Segment ${seg.train_number} arrival must be after departure`);

      if (i > 0) {
        const prevSeg = route.segments[i - 1];
        const prevArr = Date.parse(prevSeg.arrival_datetime);
        const waitMin = (segDep - prevArr) / 60_000;
        assert.ok(
          waitMin >= 30,
          `Transfer connection at ${seg.from_station.code} must be at least 30 minutes, was ${waitMin}m`
        );
      }
    }

    // Verify transfer objects match segment endpoints
    assert.equal(route.transfers.length, route.segments.length - 1);
    for (let i = 0; i < route.transfers.length; i++) {
      const transfer = route.transfers[i];
      const prevArr = Date.parse(route.segments[i].arrival_datetime);
      const nextDep = Date.parse(route.segments[i + 1].departure_datetime);
      const expectedWait = (nextDep - prevArr) / 60_000;
      assert.equal(transfer.wait_minutes, expectedWait);
      assert.ok(transfer.wait_minutes >= 30, "Transfer wait must be >= 30 minutes");
    }
  }
});

test("Ranking: strictly orders by earliest arrival and latest departure tie-break", async () => {
  const res = await handleRoutesSearch({
    stations,
    routes,
    body: { source: "NDLS", destination: "MMCT", date: "2026-11-15", time: "00:00", limit: 50 },
  });
  assert.equal(res.status, 200);
  const journeys = res.body.routes;

  for (let i = 1; i < journeys.length; i++) {
    const prev = journeys[i - 1];
    const curr = journeys[i];
    assert.ok(
      curr.arrival_datetime >= prev.arrival_datetime,
      `Rank ${curr.rank} arrives at ${curr.arrival_datetime} earlier than Rank ${prev.rank} at ${prev.arrival_datetime}`
    );

    if (curr.arrival_datetime === prev.arrival_datetime) {
      // On arrival tie, prefer latest departure (shortest trip)
      assert.ok(
        curr.departure_datetime <= prev.departure_datetime,
        `Rank ${curr.rank} departed earlier than Rank ${prev.rank} on same arrival time`
      );
    }
  }
});

test("HybridRoutingEngine Circuit Breaker: opens on consecutive failure and falls back to JS engine", async () => {
  // Point to a non-existent port to simulate engine down
  const deadHttpEngine = new HttpRoutingEngine("http://127.0.0.1:9999", 500);
  const hybrid = new HybridRoutingEngine(deadHttpEngine, jsEngine, "auto", {
    failureThreshold: 2,
    cooldownMs: 2000,
  });

  assert.equal(hybrid.isCircuitOpen(), false, "Circuit starts closed");

  // First request fails HTTP and falls back to JS
  const r1 = await hybrid.route({
    source: "NDLS",
    destination: "MMCT",
    date: "2026-11-15",
    time: "08:00",
    limit: 5,
  });
  assert.ok(r1.journeys.length > 0);
  assert.equal(hybrid.consecutiveFailures, 1);
  assert.equal(hybrid.isCircuitOpen(), false);

  // Second request fails HTTP, trips circuit breaker
  const r2 = await hybrid.route({
    source: "NDLS",
    destination: "MMCT",
    date: "2026-11-15",
    time: "08:00",
    limit: 5,
  });
  assert.ok(r2.journeys.length > 0);
  assert.equal(hybrid.consecutiveFailures, 2);
  assert.equal(hybrid.isCircuitOpen(), true, "Circuit must be OPEN after threshold failures");

  // Third request: circuit is OPEN, immediately routes to JS without waiting for HTTP timeout!
  const t0 = performance.now();
  const r3 = await hybrid.route({
    source: "NDLS",
    destination: "MMCT",
    date: "2026-11-15",
    time: "08:00",
    limit: 5,
  });
  const elapsed = performance.now() - t0;
  assert.ok(r3.journeys.length > 0);
  assert.ok(elapsed < 200, `Circuit-open routing should be fast in-memory, took ${elapsed}ms`);
});

test("API Rate Limiting: throttles requests exceeding max limit with HTTP 429", async () => {
  const app = createApp({
    stations,
    routes,
    engine: jsEngine,
    corsOrigin: null,
    rateLimitOptions: { max: 3, windowMs: 10_000 },
  });

  async function mockPostRoute() {
    return new Promise((resolve) => {
      const http = (async () => {
        const { default: httpModule } = await import("node:http");
        const { EventEmitter } = await import("node:events");
        const req = new httpModule.IncomingMessage(new EventEmitter());
        req.method = "POST";
        req.url = "/api/routes";
        req.headers = { "content-type": "application/json", host: "localhost" };
        req.body = { source: "CSMT", destination: "PUNE", date: "2026-11-15", time: "08:00", limit: 2 };
        req.ip = "127.0.0.1";

        let body = "";
        const res = new httpModule.ServerResponse(req);
        res.write = (chunk) => { body += chunk; return true; };
        res.end = (chunk) => {
          if (chunk) body += chunk;
          resolve({ status: res.statusCode, headers: res.getHeaders(), body });
        };
        app(req, res);
      })();
    });
  }

  // 3 requests within limit
  const res1 = await mockPostRoute();
  assert.equal(res1.status, 200);
  const res2 = await mockPostRoute();
  assert.equal(res2.status, 200);
  const res3 = await mockPostRoute();
  assert.equal(res3.status, 200);

  // 4th request must be rate limited
  const res4 = await mockPostRoute();
  assert.equal(res4.status, 429);
  const json4 = JSON.parse(res4.body);
  assert.equal(json4.error.code, "RATE_LIMITED");
  assert.ok(res4.headers["retry-after"] !== undefined);
});
