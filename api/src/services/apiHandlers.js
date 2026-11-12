import { z } from "zod";
import { EngineError } from "./engineClient.js";
import { StationService } from "./stationService.js";

const MAX_STATION_QUERY_LEN = 64;
const STATION_CODE_RE = /^[A-Za-z0-9_-]{1,12}$/;

export const routeSchema = z.object({
  source: z.string().trim().min(1).max(8).transform((s) => s.toUpperCase()),
  destination: z.string().trim().min(1).max(8).transform((s) => s.toUpperCase()),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .refine(
      (val) => {
        const [y, m, d] = val.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
      },
      { message: "must be a valid calendar date" }
    ),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24h)"),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  page: z.coerce.number().int().min(1).max(50).default(1),
  filters: z
    .object({
      max_duration_minutes: z.coerce.number().int().min(1).optional(),
      max_transfers: z.coerce.number().int().min(0).max(50).optional(),
      direct_only: z.boolean().optional(),
    })
    .default({}),
}).refine((r) => r.source !== r.destination, {
  message: "source and destination must differ",
  path: ["destination"],
});

export async function handleHealth({ stations, engine, uptimeSeconds = 0 }) {
  let engineStatus = null;
  try {
    engineStatus = await engine.health();
  } catch (e) {
    console.warn(`Engine health check failed: ${e.message}`);
  }
  const healthy = engineStatus !== null && stations.size > 0;
  return {
    status: healthy ? 200 : 503,
    body: {
      status: healthy ? "healthy" : "unhealthy",
      checks: {
        engine: engineStatus ? "up" : "down",
        stations: { count: stations.size, source: stations.source },
      },
      engine: engineStatus,
      uptime_s: Math.round(uptimeSeconds),
    },
  };
}

export function handleStationsSearch({ stations, query }) {
  const raw = typeof query?.q === "string" ? query.q : "";
  const q = raw.slice(0, MAX_STATION_QUERY_LEN);
  const parsedLimit = Number(query?.limit);
  const limit = Number.isFinite(parsedLimit) ? Math.min(50, Math.max(1, Math.trunc(parsedLimit))) : 10;
  return { status: 200, body: { query: q, stations: stations.search(q, limit) } };
}

export function handleStationByCode({ stations, code }) {
  const raw = typeof code === "string" ? code.trim() : "";
  if (!STATION_CODE_RE.test(raw)) {
    return {
      status: 400,
      body: { error: { code: "INVALID_STATION_CODE", message: "station code must be 1-12 alphanumeric characters" } },
    };
  }
  const s = stations.get(raw);
  if (!s) {
    return {
      status: 404,
      body: { error: { code: "STATION_NOT_FOUND", message: `unknown station code ${raw.toUpperCase()}` } },
    };
  }
  return {
    status: 200,
    body: { ...StationService.hit(s), all_known_names: s.all_known_names || [] },
  };
}

export async function handleRoutesSearch({ stations, routes, body }) {
  const parsed = routeSchema.safeParse(body || {});
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "invalid route request",
          details: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
        },
      },
    };
  }

  const q = parsed.data;
  if (!stations.get(q.source)) {
    return {
      status: 400,
      body: { error: { code: "UNKNOWN_STATION", message: `unknown source station code ${q.source}` } },
    };
  }
  if (!stations.get(q.destination)) {
    return {
      status: 400,
      body: { error: { code: "UNKNOWN_STATION", message: `unknown destination station code ${q.destination}` } },
    };
  }

  try {
    const result = await routes.search(q);
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof EngineError) {
      const status = err.kind === "invalid" ? 400 : err.kind === "overloaded" ? 429 : 503;
      return { status, body: { error: { code: "ENGINE_ERROR", message: err.message } } };
    }
    throw err;
  }
}
