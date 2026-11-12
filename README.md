# Junction IQ

A full-stack Indian Railways journey planner that computes the **50 earliest-arriving valid journeys between any two of 2,894 stations** across **1,725 train schedules**, supporting multi-transfer connections, live route filtering, dark/light themes, and interactive map visualization.

Built by **Nikky** (`nikkycsai2006@gmail.com`).

---

## Features

- **Earliest-Arrival K-Best Routing**: Ranks direct trains and multi-transfer itineraries together using a backward connection scan lower bound + best-first A* search (30-minute minimum transfer buffer, up to 50 ranked journeys).
- **Hybrid Routing Engine**: Runs natively in Node.js and Netlify Serverless Functions (`JsRoutingEngine`), with optional delegation to the C++20 engine (`HttpRoutingEngine`) for Docker/Linux deployments.
- **Interactive Route Map**: Plots journey legs, intermediate stops, and transfer junctions on Esri Light/Dark Gray Canvas tiles via Leaflet with automatic theme synchronization.
- **Smart Filtering & Sorting**: Filter by direct-only, max transfers, max duration, min transfer buffer, or excluded trains; sort by arrival, duration, transfers, waiting time, or distance.
- **Popular Corridors & Recent Searches**: One-click corridor shortcuts (`NDLS → MMCT`, `CSMT → PUNE`, `HWH → MAS`, `SBC → NDLS`) and persistent `localStorage` recent searches.
- **Dark & Light Mode**: Tokenized CSS design system with a header theme toggle persisted across sessions.

## Tech Stack

- **Frontend**: React 19, TypeScript 5.9, Vite 6, Tailwind CSS v4, Leaflet / React-Leaflet, Plus Jakarta Sans + Inter + JetBrains Mono
- **API & Serverless Engine**: Node.js 22, Express 5, Zod 4, Netlify Functions (`netlify/functions/api.mjs`), K-best A* JS routing engine
- **High-Throughput Core (Docker/Linux)**: C++20, CMake, `cpp-httplib`, `nlohmann/json`, `doctest`
- **Data Pipeline**: TypeScript preprocessing & DataMeet CC0 station geocoding (`scripts/`)

## Local Setup

### Prerequisites
- **Node.js ≥ 22.16** & **npm**
- *(Optional, for Docker / native C++ engine)*: Docker Desktop, or CMake ≥ 3.20 + C++20 compiler

### 1. Configure Environment

```bash
cp .env.example .env
```

### 2. Install & Run Locally

Install dependencies once in `api/` and `frontend/`:

```bash
cd api && npm ci
cd ../frontend && npm ci
```

Start both the API (`:4000`) and Vite frontend (`:3000`) from the project root:

```bash
npm run dev
```

Open `http://localhost:3000`.

### 3. Run Tests & Build

```bash
cd api && npm test
cd ../scripts && npm test
cd ../frontend && npm run typecheck && npm run build
```

### 4. Docker Full Stack (with C++ Engine)

```bash
docker compose up -d --build
```

## Environment Variables

| Variable | Component | Purpose |
|---|---|---|
| `PORT` | Frontend | Production proxy server port (default `3000`) |
| `HOST` | Frontend | Bind address (default `0.0.0.0`) |
| `PUBLIC_PORT` | Docker | Host port mapped to frontend (`80`) |
| `API_INTERNAL_URL` | Frontend | Upstream API URL for `/api/*` proxy |
| `API_PORT` | API | Express server port (default `4000`) |
| `API_HOST` | API | Bind address (default `0.0.0.0`) |
| `ENGINE_MODE` | API | Routing mode: `auto`, `http`, or `js` |
| `ENGINE_URL` | API | C++ engine base URL (when using `http` or `auto`) |
| `CORS_ORIGIN` | API | Optional allowed CORS origin |
| `MAX_RESULTS` | API / Netlify | Maximum journeys returned per search (`50`) |
| `STATIONS_FILE` | API / Netlify | Path to `stations.json` |
| `TIMETABLE_PATH` | API / Engine | Path to `timetable.json` |
| `ENGINE_HOST` | C++ Engine | Bind address (`0.0.0.0`) |
| `ENGINE_PORT` | C++ Engine | Engine HTTP port (`7070`) |
| `ENGINE_THREADS` | C++ Engine | Worker thread count |
| `ADMIN_PORT` | C++ Engine | Admin HTTP port (`7071`) |
| `WORKER_ID` | C++ Engine | Worker identifier reported in metadata |
| `SHUTDOWN_GRACE_MS` | C++ Engine | Graceful shutdown drain timeout |
| `MIN_TRANSFER_MINUTES` | C++ Engine | Minimum transfer buffer in minutes (`30`) |
| `MAX_TRANSFERS_INTERNAL` | C++ Engine | Maximum transfers allowed |
| `TOP_K` | C++ Engine | Number of top journeys computed (`50`) |
| `K_NODE` | C++ Engine | Optional per-station node visit cap |
| `SEARCH_HORIZON_MINUTES` | C++ Engine | Search window in minutes (`5760`) |
| `MAX_LABELS` | C++ Engine | Label budget cap (`500000`) |
| `RAW_DATA_DIR` | Scripts | Raw train JSON input directory |
| `PROCESSED_DIR` | Scripts | Output directory for processed JSON |
| `REPORTS_DIR` | Scripts | Output directory for quality/geocode reports |
| `CLEAN_POLICY` | Scripts | Normalization policy (`strict`, `correct`, `skip`) |

## Deployment (Netlify)

Junction IQ includes [netlify.toml](netlify.toml) and [netlify/functions/api.mjs](netlify/functions/api.mjs) for full-stack deployment on Netlify:

- **Build command**: `cd api && npm ci && cd ../frontend && npm ci && npm run build`
- **Publish directory**: `frontend/dist`
- **Functions directory**: `netlify/functions`

## Third-Party Notices

- `routing-engine/third_party/doctest.h` — MIT License (Viktor Kirilov)
- `routing-engine/third_party/httplib.h` — MIT License (Yuji Hirose)
- `routing-engine/third_party/json.hpp` — MIT License (Niels Lohmann)
- `data/external/datameet-stations.json` — CC0 / Open Data from DataMeet Railways; map tiles © Esri, OpenStreetMap contributors

## License

MIT License — Copyright (c) 2026 Nikky. See [LICENSE](LICENSE).
