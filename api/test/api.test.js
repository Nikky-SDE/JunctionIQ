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
import { JourneyRenderer } from "../src/services/journeyRenderer.js";
import { JsRoutingEngine } from "../src/services/jsEngine.js";
import { RouteService } from "../src/services/routeService.js";
import { loadStationsFromFile, StationService } from "../src/services/stationService.js";
import { handler as netlifyHandler } from "../../netlify/functions/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const stationsFile = resolve(here, "../../data/processed/stations.json");
const timetablePath = resolve(here, "../../data/processed/timetable.json");

const stations = new StationService();
stations.load(await loadStationsFromFile(stationsFile), "file");
const renderer = JourneyRenderer.fromFile(timetablePath);
const engine = JsRoutingEngine.fromFile(timetablePath);
const routes = new RouteService(engine, stations, renderer, 50);

test("StationService searches, caps query length, and rejects malformed codes", () => {
  const search = handleStationsSearch({ stations, query: { q: "NDLS", limit: "5" } });
  assert.equal(search.status, 200);
  assert.equal(search.body.stations[0].code, "NDLS");

  const longQuery = handleStationsSearch({ stations, query: { q: "N".repeat(200), limit: "NaN" } });
  assert.equal(longQuery.status, 200);
  assert.equal(longQuery.body.query.length, 64);

  const badCode = handleStationByCode({ stations, code: "<script>alert(1)</script>" });
  assert.equal(badCode.status, 400);
  assert.equal(badCode.body.error.code, "INVALID_STATION_CODE");

  const missing = handleStationByCode({ stations, code: "NOPE" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "STATION_NOT_FOUND");
});

test("handleHealth reports healthy with JsRoutingEngine", async () => {
  const res = await handleHealth({ stations, engine, uptimeSeconds: 12 });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "healthy");
  assert.equal(res.body.checks.engine, "up");
  assert.equal(res.body.checks.stations.count, 2894);
});

test("handleRoutesSearch validates inputs and rejects identical stations", async () => {
  const bad = await handleRoutesSearch({
    stations,
    routes,
    body: { source: "NDLS", destination: "NDLS", date: "2026-11-15", time: "08:00" },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "VALIDATION_ERROR");

  const unknown = await handleRoutesSearch({
    stations,
    routes,
    body: { source: "ZZZZ", destination: "NDLS", date: "2026-11-15", time: "08:00" },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, "UNKNOWN_STATION");
});

test("JsRoutingEngine computes valid ranked earliest-arrival journeys and preserves direct trains", async () => {
  const res = await handleRoutesSearch({
    stations,
    routes,
    body: { source: "NDLS", destination: "MMCT", date: "2026-11-15", time: "08:00", limit: 10 },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.routes.length > 0);
  for (let i = 1; i < res.body.routes.length; i++) {
    assert.ok(
      res.body.routes[i].arrival_datetime >= res.body.routes[i - 1].arrival_datetime,
      "journeys must be ordered by earliest arrival",
    );
  }

  for (const [source, destination] of [["DLI", "LKO"], ["SBC", "NDLS"]]) {
    const allRes = await handleRoutesSearch({
      stations,
      routes,
      body: { source, destination, date: "2026-11-15", time: "00:00", limit: 50 },
    });
    assert.equal(allRes.status, 200);
    assert.ok(allRes.body.routes.some((r) => r.is_direct), `${source}->${destination} should include direct train`);

    const directRes = await handleRoutesSearch({
      stations,
      routes,
      body: { source, destination, date: "2026-11-15", time: "00:00", limit: 50, filters: { direct_only: true } },
    });
    assert.equal(directRes.status, 200);
    assert.ok(directRes.body.routes.length > 0);
    assert.ok(directRes.body.routes.every((r) => r.is_direct));
  }
});

test("Netlify serverless handler serves stations, validates bad JSON, and routes cleanly", async () => {
  const stRes = await netlifyHandler({
    httpMethod: "GET",
    path: "/api/stations",
    queryStringParameters: { q: "PUNE", limit: "3" },
  });
  assert.equal(stRes.statusCode, 200);
  const stJson = JSON.parse(stRes.body);
  assert.equal(stJson.stations[0].code, "PUNE");

  const badJsonRes = await netlifyHandler({
    httpMethod: "POST",
    path: "/.netlify/functions/api/routes",
    body: "{invalid json",
  });
  assert.equal(badJsonRes.statusCode, 400);
  assert.equal(JSON.parse(badJsonRes.body).error.code, "INVALID_JSON");

  const rtRes = await netlifyHandler({
    httpMethod: "POST",
    path: "/.netlify/functions/api/routes",
    body: JSON.stringify({ source: "CSMT", destination: "PUNE", date: "2026-11-15", time: "08:00", limit: 5 }),
  });
  assert.equal(rtRes.statusCode, 200);
  const rtJson = JSON.parse(rtRes.body);
  assert.ok(rtJson.routes.length > 0);
  assert.equal(rtJson.query.source, "CSMT");
  assert.equal(rtJson.query.destination, "PUNE");
});
