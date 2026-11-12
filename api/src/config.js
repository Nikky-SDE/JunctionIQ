import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function loadConfig() {
  const mode = (process.env.ENGINE_MODE || "auto").trim().toLowerCase();
  return {
    port: Number(process.env.API_PORT) || 4000,
    host: process.env.API_HOST || "0.0.0.0",
    engineMode: ["auto", "http", "js"].includes(mode) ? mode : "auto",
    engineUrl: (process.env.ENGINE_URL || "http://127.0.0.1:7070").trim().replace(/\/$/, ""),
    stationsFile: process.env.STATIONS_FILE || resolve(here, "../../data/processed/stations.json"),
    timetablePath: process.env.TIMETABLE_PATH || resolve(here, "../../data/processed/timetable.json"),
    corsOrigin: process.env.CORS_ORIGIN || null,
    maxResults: Number(process.env.MAX_RESULTS) || 50,
  };
}
