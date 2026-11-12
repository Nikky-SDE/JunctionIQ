import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFilters,
  FILTER_DEFAULTS,
  filtersFromParams,
  filtersToParams,
  sortJourneys,
  type FilterState,
} from "../src/lib/filters.ts";
import { boundsOf, smoothPath, type LatLon } from "../src/lib/geo.ts";
import { highlightBadges, HIGHLIGHTS } from "../src/lib/highlights.ts";
import type { Journey } from "../src/lib/types.ts";

function makeJourney(overrides: Partial<Journey>): Journey {
  return {
    rank: 1,
    id: "12952:NDLS>MMCT:0",
    source: { code: "NDLS", name: "NEW DELHI" },
    destination: { code: "MMCT", name: "MUMBAI CENTRAL" },
    departure_datetime: "2026-11-15T08:00:00",
    arrival_datetime: "2026-11-15T20:00:00",
    duration_minutes: 720,
    total_elapsed_duration_minutes: 720,
    initial_wait_minutes: 0,
    train_travel_minutes: 720,
    waiting_minutes: 0,
    transfer_count: 0,
    segment_count: 1,
    is_direct: true,
    distance_km: 1386,
    train_numbers: ["12952"],
    segments: [],
    transfers: [],
    ...overrides,
  };
}

test("URL state: filtersToParams and filtersFromParams roundtrip", () => {
  const originalFilters: FilterState = {
    directOnly: true,
    maxTransfers: 2,
    minConnection: 45,
    maxLayover: 120,
    excludedTrains: ["12952", "12951"],
  };
  const sort = "duration";

  const params = new URLSearchParams();
  filtersToParams(originalFilters, sort, params);

  assert.equal(params.get("direct"), "1");
  assert.equal(params.get("maxtr"), "2");
  assert.equal(params.get("minconn"), "45");
  assert.equal(params.get("maxwait"), "120");
  assert.equal(params.get("xtrain"), "12952,12951");
  assert.equal(params.get("sort"), "duration");

  const restored = filtersFromParams(params);
  assert.deepEqual(restored.filters, originalFilters);
  assert.equal(restored.sort, sort);
});

test("Filtering: applyFilters respects all predicates", () => {
  const jDirect = makeJourney({ rank: 1, transfer_count: 0, is_direct: true, duration_minutes: 600, train_numbers: ["10001"] });
  const jTransfer1 = makeJourney({
    rank: 2,
    transfer_count: 1,
    is_direct: false,
    duration_minutes: 500,
    transfers: [{ station: { code: "BPL", name: "BHOPAL" }, arrival_datetime: "", departure_datetime: "", wait_minutes: 60 }],
    train_numbers: ["10002", "10003"],
  });
  const jTransfer2 = makeJourney({
    rank: 3,
    transfer_count: 2,
    is_direct: false,
    duration_minutes: 800,
    transfers: [
      { station: { code: "BPL", name: "BHOPAL" }, arrival_datetime: "", departure_datetime: "", wait_minutes: 30 },
      { station: { code: "BSL", name: "BHUSAWAL" }, arrival_datetime: "", departure_datetime: "", wait_minutes: 180 },
    ],
    train_numbers: ["10004", "10005", "10006"],
  });

  const list = [jDirect, jTransfer1, jTransfer2];

  // Direct only
  const directOnly = applyFilters(list, { ...FILTER_DEFAULTS, directOnly: true });
  assert.equal(directOnly.length, 1);
  assert.equal(directOnly[0].rank, 1);

  // Max transfers <= 1
  const max1 = applyFilters(list, { ...FILTER_DEFAULTS, maxTransfers: 1 });
  assert.equal(max1.length, 2);

  // Min connection >= 45m (jTransfer2 has a 30m connection, so dropped)
  const minConn = applyFilters(list, { ...FILTER_DEFAULTS, minConnection: 45 });
  assert.equal(minConn.length, 2); // direct has no transfers (vacuously true) + jTransfer1 (wait 60)

  // Max layover <= 120m (jTransfer2 has a 180m wait, so dropped)
  const maxWait = applyFilters(list, { ...FILTER_DEFAULTS, maxLayover: 120 });
  assert.equal(maxWait.length, 2);

  // Excluded train
  const excluded = applyFilters(list, { ...FILTER_DEFAULTS, excludedTrains: ["10002"] });
  assert.equal(excluded.length, 2);
  assert.ok(!excluded.some((j) => j.train_numbers.includes("10002")));
});

test("Sorting: sortJourneys sorts correctly by all keys", () => {
  const j1 = makeJourney({ rank: 1, duration_minutes: 600, transfer_count: 2, waiting_minutes: 100, distance_km: 1200 });
  const j2 = makeJourney({ rank: 2, duration_minutes: 400, transfer_count: 0, waiting_minutes: 0, distance_km: 1400 });
  const j3 = makeJourney({ rank: 3, duration_minutes: 500, transfer_count: 1, waiting_minutes: 50, distance_km: 1100 });
  const list = [j1, j2, j3];

  assert.deepEqual(sortJourneys(list, "arrival").map((j) => j.rank), [1, 2, 3]);
  assert.deepEqual(sortJourneys(list, "duration").map((j) => j.rank), [2, 3, 1]);
  assert.deepEqual(sortJourneys(list, "transfers").map((j) => j.rank), [2, 3, 1]);
  assert.deepEqual(sortJourneys(list, "waiting").map((j) => j.rank), [2, 3, 1]);
  assert.deepEqual(sortJourneys(list, "distance").map((j) => j.rank), [3, 1, 2]);
});

test("Geo utilities: boundsOf and smoothPath", () => {
  const points: LatLon[] = [
    [28.6139, 77.2090], // Delhi
    [19.0760, 72.8777], // Mumbai
  ];
  const bounds = boundsOf(points);
  assert.ok(bounds !== null);
  assert.equal(bounds[0][0], 19.0760);
  assert.equal(bounds[0][1], 72.8777);
  assert.equal(bounds[1][0], 28.6139);
  assert.equal(bounds[1][1], 77.2090);

  const emptyBounds = boundsOf([]);
  assert.equal(emptyBounds, null);

  const smoothed = smoothPath(points);
  assert.ok(smoothed.length >= points.length);
});

test("SummaryStrip: highlightBadges picks distinct best journeys", () => {
  const j1 = makeJourney({ id: "j1", rank: 1, duration_minutes: 700, transfer_count: 0, waiting_minutes: 0 });
  const j2 = makeJourney({ id: "j2", rank: 2, duration_minutes: 400, transfer_count: 1, waiting_minutes: 60 });
  const badges = highlightBadges([j1, j2]);

  assert.ok(badges.get("j1")?.includes("Earliest arrival"));
  assert.ok(badges.get("j1")?.includes("Fewest changes"));
  assert.ok(badges.get("j1")?.includes("Least waiting"));
  assert.ok(badges.get("j2")?.includes("Shortest trip"));
});
