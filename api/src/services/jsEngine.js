import { readFileSync } from "node:fs";
import { EngineError } from "./engineClient.js";
import { fnv1a64Hex } from "./journeyRenderer.js";

const NO_TIME = -1;
const NO_STATION = -1;
const INF = 0x3fffffff;

/**
 * Min-heap priority queue ordered by:
 * 1. lowerBound (estimated earliest arrival)
 * 2. -firstDep (prefer later departure on tie)
 * 3. transfers (fewer transfers on tie)
 * 4. waiting (less waiting time on tie)
 */
class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(node) {
    const a = this.items;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compareLabels(a[i], a[p]) < 0) {
        const tmp = a[i];
        a[i] = a[p];
        a[p] = tmp;
        i = p;
      } else {
        break;
      }
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      while (true) {
        let best = i;
        const l = (i << 1) + 1;
        const r = l + 1;
        if (l < n && compareLabels(a[l], a[best]) < 0) best = l;
        if (r < n && compareLabels(a[r], a[best]) < 0) best = r;
        if (best === i) break;
        const tmp = a[i];
        a[i] = a[best];
        a[best] = tmp;
        i = best;
      }
    }
    return top;
  }
}

function compareLabels(a, b) {
  if (a.lb !== b.lb) return a.lb - b.lb;
  if (a.firstDep !== b.firstDep) return b.firstDep - a.firstDep;
  if (a.transfers !== b.transfers) return a.transfers - b.transfers;
  return a.waiting - b.waiting;
}

function queryStationLowerBound(entries, minDep) {
  if (!entries || entries.length === 0) return INF;
  let lo = 0;
  let hi = entries.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].dep >= minDep) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? entries[ans].arr : INF;
}

/**
 * Pure JavaScript/Node.js K-best earliest-arrival routing engine compatible with
 * the `railway-timetable/v1` format used by Junction IQ's C++ engine and JourneyRenderer.
 */
export class JsRoutingEngine {
  constructor(bytes, options = {}) {
    const t0 = performance.now();
    this.hash = fnv1a64Hex(bytes);
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    if (doc.format !== "railway-timetable/v1") {
      throw new Error("unsupported timetable format");
    }

    this.minTransferMinutes = options.minTransferMinutes ?? 30;
    this.maxTransfers = options.maxTransfers ?? 6;
    this.horizonMinutes = options.horizonMinutes ?? 5760;
    this.maxLabels = options.maxLabels ?? 150_000;

    this.stationByCode = new Map();
    doc.stations.forEach((s, idx) => {
      this.stationByCode.set(s.code, idx);
    });
    this.stationCount = doc.stations.length;

    this.trains = [];
    this.maxSpanDays = 1;
    this.departuresByStation = Array.from({ length: this.stationCount }, () => []);

    for (const t of doc.trains) {
      if ((t.days & 0x7f) === 0) continue;
      const trainIdx = this.trains.length;
      const stops = t.stops.map((r) => ({
        station: r[0],
        arr: r[1],
        dep: r[2],
      }));
      const lastStop = stops[stops.length - 1];
      const maxTime = Math.max(lastStop.arr, lastStop.dep, 0);
      const spanDays = Math.max(1, Math.ceil((maxTime + 1) / 1440));
      if (spanDays > this.maxSpanDays) this.maxSpanDays = spanDays;

      const stationSet = new Set();
      for (let i = 0; i < stops.length; i++) {
        const st = stops[i];
        if (st.station !== NO_STATION) {
          stationSet.add(st.station);
          if (i < stops.length - 1 && st.dep !== NO_TIME) {
            this.departuresByStation[st.station].push({
              train: trainIdx,
              stop: i,
              depRel: st.dep,
              daysMask: t.days & 0x7f,
            });
          }
        }
      }

      this.trains.push({
        number: t.number,
        daysMask: t.days & 0x7f,
        stops,
        stationSet,
        maxTime,
      });
    }

    this.loadMs = Math.round((performance.now() - t0) * 100) / 100;
  }

  static fromFile(path, options) {
    return new JsRoutingEngine(readFileSync(path), options);
  }

  async health() {
    return {
      status: "ok",
      engine: "js-astar",
      timetable: this.hash,
      stations: this.stationCount,
      trains: this.trains.length,
      load_ms: this.loadMs,
    };
  }

  async route(query) {
    const t0 = performance.now();
    const src = this.stationByCode.get(String(query.source || "").toUpperCase());
    const dst = this.stationByCode.get(String(query.destination || "").toUpperCase());
    if (src === undefined || dst === undefined || src === dst) {
      throw new EngineError("invalid source or destination station", 400, "invalid");
    }

    const dateDay = Math.floor(Date.parse(`${query.date}T00:00:00Z`) / 86_400_000);
    if (!Number.isFinite(dateDay)) {
      throw new EngineError("invalid date", 400, "invalid");
    }
    const [hh, mm] = String(query.time || "00:00").split(":").map(Number);
    const searchMinute = dateDay * 1440 + hh * 60 + mm;
    const firstLegLastDep = dateDay * 1440 + 1439;
    const horizonEnd = searchMinute + this.horizonMinutes;
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 50));

    const directOnly = Boolean(query.direct_only);
    const effectiveMaxTransfers = directOnly
      ? 0
      : query.max_transfers !== undefined
        ? Math.min(this.maxTransfers, Math.max(0, Number(query.max_transfers)))
        : this.maxTransfers;

    // 1. Enumerate active train instances within the search horizon window
    const dayLo = dateDay - this.maxSpanDays;
    const dayHi = dateDay + Math.ceil(this.horizonMinutes / 1440);
    const instances = [];
    const instLookup = new Map();
    let totalStops = 0;

    for (let d = dayLo; d <= dayHi; d++) {
      const weekday = new Date(d * 86_400_000).getUTCDay();
      const bit = 1 << weekday;
      const base = d * 1440;
      for (let t = 0; t < this.trains.length; t++) {
        const tr = this.trains[t];
        if ((tr.daysMask & bit) === 0) continue;
        if (base + tr.maxTime < searchMinute || base > horizonEnd) continue;
        if (directOnly && (!tr.stationSet.has(src) || !tr.stationSet.has(dst))) continue;
        const instIdx = instances.length;
        instances.push({ train: t, startDay: d, base, offset: totalStops });
        instLookup.set(t * 1_000_000 + d, instIdx);
        totalStops += tr.stops.length;
      }
    }

    // Fast direct-only search when requested
    if (directOnly) {
      const directJourneys = this.#findDirectJourneys(instances, src, dst, searchMinute, horizonEnd, limit);
      return {
        timetable: this.hash,
        search_minute: searchMinute,
        search_complete: true,
        worker: "js-engine",
        stats: { total_ms: Math.round((performance.now() - t0) * 100) / 100, labels_created: directJourneys.length },
        journeys: directJourneys,
      };
    }

    // 2. Build active connections & run backward profile lower-bound scan
    const connections = [];
    for (let instIdx = 0; instIdx < instances.length; instIdx++) {
      const inst = instances[instIdx];
      const stops = this.trains[inst.train].stops;
      for (let s = 0; s < stops.length - 1; s++) {
        const a = stops[s];
        const b = stops[s + 1];
        if (a.dep === NO_TIME || b.arr === NO_TIME) continue;
        const depAbs = inst.base + a.dep;
        const arrAbs = inst.base + b.arr;
        if (arrAbs < searchMinute || depAbs > horizonEnd) continue;
        connections.push({ depAbs, arrAbs, instIdx, stop: s });
      }
    }
    connections.sort((a, b) => b.depAbs - a.depAbs);

    const stopBound = new Int32Array(totalStops);
    stopBound.fill(INF);
    const stationProfile = Array.from({ length: this.stationCount }, () => []);

    for (let i = 0; i < connections.length; i++) {
      const c = connections[i];
      const inst = instances[c.instIdx];
      const stops = this.trains[inst.train].stops;
      const nextStop = c.stop + 1;
      const v = stops[nextStop].station;

      let best = INF;
      if (v === dst) {
        best = c.arrAbs;
      } else {
        const stay = stopBound[inst.offset + nextStop];
        if (stay < best) best = stay;
        if (v !== NO_STATION && effectiveMaxTransfers > 0) {
          const xfer = queryStationLowerBound(stationProfile[v], c.arrAbs + this.minTransferMinutes);
          if (xfer < best) best = xfer;
        }
      }

      if (best < stopBound[inst.offset + c.stop]) {
        stopBound[inst.offset + c.stop] = best;
      }

      const u = stops[c.stop].station;
      if (u !== NO_STATION && best < INF) {
        const list = stationProfile[u];
        const prev = list.length > 0 ? list[list.length - 1] : null;
        if (!prev || best < prev.arr) {
          if (prev && prev.dep === c.depAbs) {
            prev.arr = best;
          } else {
            list.push({ dep: c.depAbs, arr: best });
          }
        }
      }
    }

    // 3. Best-first A* search from source station
    const pq = new MinHeap();
    let labelsCreated = 0;

    // Seed initial boardings from `src`
    for (let instIdx = 0; instIdx < instances.length; instIdx++) {
      const inst = instances[instIdx];
      const tr = this.trains[inst.train];
      if (!tr.stationSet.has(src)) continue;
      for (let s = 0; s < tr.stops.length - 1; s++) {
        const st = tr.stops[s];
        if (st.station !== src || st.dep === NO_TIME) continue;
        const depAbs = inst.base + st.dep;
        if (depAbs < searchMinute || depAbs > firstLegLastDep) continue;
        const lb = stopBound[inst.offset + s];
        if (lb >= INF) continue;
        labelsCreated++;
        pq.push({
          lb,
          firstDep: depAbs,
          transfers: 0,
          waiting: 0,
          instIdx,
          stop: s,
          boardStop: s,
          boardDep: depAbs,
          trainMinutes: 0,
          visited: new Set([src]),
          usedTrains: new Set([inst.train]),
          prev: null,
        });
      }
    }

    const journeys = [];
    const seenSignatures = new Set();
    let searchComplete = true;

    while (pq.size > 0 && journeys.length < limit) {
      const cur = pq.pop();
      const inst = instances[cur.instIdx];
      const tr = this.trains[inst.train];
      const nextStopIdx = cur.stop + 1;
      if (nextStopIdx >= tr.stops.length) continue;

      const curStop = tr.stops[cur.stop];
      const nextStop = tr.stops[nextStopIdx];
      const arrAbs = inst.base + nextStop.arr;
      const hopStation = nextStop.station;

      // No repeated station check (except if hopStation is non-boardable placeholder)
      if (hopStation !== NO_STATION && cur.visited.has(hopStation)) {
        continue;
      }

      const legTrainMinutes = arrAbs - cur.boardDep;

      // Case A: Reached destination!
      if (hopStation === dst) {
        const legs = collectLegs(cur, instances, nextStopIdx);
        if (
          this.#boardsTrainLate(legs, cur.firstDep, arrAbs, src, searchMinute, firstLegLastDep) ||
          this.#leavesTrainEarly(legs)
        ) {
          continue;
        }
        const signature = legs
          .map(([t, b, a]) => `${this.trains[t].number}:${this.trains[t].stops[b].station}>${this.trains[t].stops[a].station}`)
          .join("|");
        if (!seenSignatures.has(signature)) {
          seenSignatures.add(signature);
          journeys.push({
            signature,
            dep: cur.firstDep,
            arr: arrAbs,
            transfers: cur.transfers,
            train_minutes: cur.trainMinutes + legTrainMinutes,
            waiting_minutes: cur.waiting,
            legs,
          });
        }
        continue;
      }

      if (labelsCreated >= this.maxLabels) {
        searchComplete = false;
        break;
      }

      const nextVisited = hopStation !== NO_STATION ? new Set(cur.visited).add(hopStation) : cur.visited;

      // Case B: Ride on to next stop on the same train
      if (nextStopIdx < tr.stops.length - 1 && nextStop.dep !== NO_TIME) {
        const stayLb = stopBound[inst.offset + nextStopIdx];
        if (stayLb < INF) {
          labelsCreated++;
          pq.push({
            lb: stayLb,
            firstDep: cur.firstDep,
            transfers: cur.transfers,
            waiting: cur.waiting,
            instIdx: cur.instIdx,
            stop: nextStopIdx,
            boardStop: cur.boardStop,
            boardDep: cur.boardDep,
            trainMinutes: cur.trainMinutes,
            visited: nextVisited,
            usedTrains: cur.usedTrains,
            prev: cur.prev,
          });
        }
      }

      // Case C: Alight at hopStation and transfer (skip if current train already reaches dst!)
      if (
        hopStation !== NO_STATION &&
        cur.transfers < effectiveMaxTransfers &&
        !trainReachesLater(tr, nextStopIdx, dst)
      ) {
        const minDep = arrAbs + this.minTransferMinutes;
        const deps = this.departuresByStation[hopStation];
        const legNode = {
          train: inst.train,
          board: cur.boardStop,
          alight: nextStopIdx,
          startDay: inst.startDay,
          dep: cur.boardDep,
          arr: arrAbs,
          prev: cur.prev,
        };
        const accTrainMinutes = cur.trainMinutes + legTrainMinutes;

        for (let i = 0; i < deps.length; i++) {
          const ev = deps[i];
          if (cur.usedTrains.has(ev.train)) continue;
          const minStartDay = Math.floor((minDep - ev.depRel) / 1440);
          for (let offsetDay = 0; offsetDay <= 2; offsetDay++) {
            const sd = minStartDay + offsetDay;
            const depTime = sd * 1440 + ev.depRel;
            if (depTime < minDep || depTime > horizonEnd) continue;
            const nextInstIdx = instLookup.get(ev.train * 1_000_000 + sd);
            if (nextInstIdx === undefined) continue;
            const xferLb = stopBound[instances[nextInstIdx].offset + ev.stop];
            if (xferLb >= INF) continue;
            if (labelsCreated >= this.maxLabels) {
              searchComplete = false;
              break;
            }
            labelsCreated++;
            pq.push({
              lb: xferLb,
              firstDep: cur.firstDep,
              transfers: cur.transfers + 1,
              waiting: cur.waiting + (depTime - arrAbs),
              instIdx: nextInstIdx,
              stop: ev.stop,
              boardStop: ev.stop,
              boardDep: depTime,
              trainMinutes: accTrainMinutes,
              visited: nextVisited,
              usedTrains: new Set(cur.usedTrains).add(ev.train),
              prev: legNode,
            });
            break;
          }
          if (!searchComplete) break;
        }
      }
    }

    if (!directOnly && journeys.length === limit && !journeys.some((j) => j.transfers === 0)) {
      const directsOnDate = this.#findDirectJourneys(instances, src, dst, searchMinute, firstLegLastDep, 5);
      if (directsOnDate.length > 0) {
        const keep = Math.max(0, limit - directsOnDate.length);
        journeys.splice(keep);
        journeys.push(...directsOnDate);
        journeys.sort((a, b) => a.arr - b.arr || b.dep - a.dep || a.transfers - b.transfers);
      }
    }

    return {
      timetable: this.hash,
      search_minute: searchMinute,
      search_complete: searchComplete,
      worker: "js-engine",
      stats: { total_ms: Math.round((performance.now() - t0) * 100) / 100, labels_created: labelsCreated },
      journeys,
    };
  }

  #findDirectJourneys(instances, src, dst, searchMinute, horizonEnd, limit) {
    const out = [];
    const seen = new Set();
    for (let instIdx = 0; instIdx < instances.length; instIdx++) {
      const inst = instances[instIdx];
      const tr = this.trains[inst.train];
      for (let b = 0; b < tr.stops.length - 1; b++) {
        const bs = tr.stops[b];
        if (bs.station !== src || bs.dep === NO_TIME) continue;
        const depAbs = inst.base + bs.dep;
        if (depAbs < searchMinute || depAbs > horizonEnd) continue;
        for (let a = b + 1; a < tr.stops.length; a++) {
          const as = tr.stops[a];
          if (as.station !== dst || as.arr === NO_TIME) continue;
          const arrAbs = inst.base + as.arr;
          const signature = `${tr.number}:${src}>${dst}:${inst.startDay}`;
          if (!seen.has(signature)) {
            seen.add(signature);
            out.push({
              signature,
              dep: depAbs,
              arr: arrAbs,
              transfers: 0,
              train_minutes: arrAbs - depAbs,
              waiting_minutes: 0,
              legs: [[inst.train, b, a, inst.startDay]],
            });
          }
          break;
        }
      }
    }
    out.sort((x, y) => x.arr - y.arr || y.dep - x.dep);
    return out.slice(0, limit);
  }

  #collectStopStations(leg, fromIdx, toIdx, out) {
    const stops = this.trains[leg[0]].stops;
    for (let k = fromIdx; k <= toIdx; k++) {
      const st = stops[k].station;
      if (st !== NO_STATION) out.push(st);
    }
  }

  #hasDuplicateStations(arr) {
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) {
      if (seen.has(arr[i])) return true;
      seen.add(arr[i]);
    }
    return false;
  }

  #boardsTrainLate(legs, firstDep, finalArr, src, searchMinute, firstLegLastDep) {
    const n = legs.length;
    if (n < 2) return false;

    for (let li = 1; li < n; li++) {
      const leg = legs[li];
      const tr = this.trains[leg[0]];
      const base = leg[3] * 1440;

      const rest = [];
      for (let r = li; r < n; r++) {
        const fromIdx = r > li ? legs[r][1] + 1 : legs[r][1];
        this.#collectStopStations(legs[r], fromIdx, legs[r][2], rest);
      }

      const prefix = [src];
      for (let m = 0; m < li; m++) {
        let pStation;
        let lo;
        let hi;
        if (m === 0) {
          pStation = src;
          lo = Math.max(searchMinute, firstDep);
          hi = firstLegLastDep;
        } else {
          const prevLeg = legs[m - 1];
          const prevTr = this.trains[prevLeg[0]];
          pStation = prevTr.stops[prevLeg[2]].station;
          const prevArr = prevLeg[3] * 1440 + prevTr.stops[prevLeg[2]].arr;
          lo = prevArr + this.minTransferMinutes;
          hi = INF;
          this.#collectStopStations(prevLeg, prevLeg[1] + 1, prevLeg[2], prefix);
        }

        for (let jst = 0; jst < leg[1]; jst++) {
          const sj = tr.stops[jst];
          if (sj.station !== pStation || sj.dep === NO_TIME) continue;
          const dj = base + sj.dep;
          if (dj < lo || dj > hi) continue;

          const all = prefix.slice(0, -1);
          this.#collectStopStations(leg, jst, leg[1] - 1, all);
          for (let r = 0; r < rest.length; r++) all.push(rest[r]);
          if (!this.#hasDuplicateStations(all)) return true;
        }
      }
    }
    return false;
  }

  #leavesTrainEarly(legs) {
    const n = legs.length;
    for (let li = 0; li + 1 < n; li++) {
      const leg = legs[li];
      const t1 = this.trains[leg[0]];
      const base = leg[3] * 1440;

      for (let m = li + 1; m < n; m++) {
        const lm = legs[m];
        const lmTr = this.trains[lm[0]];
        const lmArr = lm[3] * 1440 + lmTr.stops[lm[2]].arr;
        const zStation = lmTr.stops[lm[2]].station;

        for (let z = leg[2] + 1; z < t1.stops.length; z++) {
          if (t1.stops[z].station !== zStation || t1.stops[z].arr === NO_TIME) continue;
          if (base + t1.stops[z].arr > lmArr) break;

          const all = [];
          for (let r = 0; r <= li; r++) {
            const kStart = r > 0 ? legs[r][1] + 1 : legs[r][1];
            const kEnd = r === li ? z : legs[r][2];
            this.#collectStopStations(legs[r], kStart, kEnd, all);
          }
          for (let r = m + 1; r < n; r++) {
            this.#collectStopStations(legs[r], legs[r][1] + 1, legs[r][2], all);
          }
          if (!this.#hasDuplicateStations(all)) return true;
          break;
        }
      }
    }
    return false;
  }
}

function trainReachesLater(tr, fromStop, dst) {
  if (!tr.stationSet.has(dst)) return false;
  for (let i = fromStop + 1; i < tr.stops.length; i++) {
    if (tr.stops[i].station === dst) return true;
  }
  return false;
}

function collectLegs(cur, instances, finalAlightStop) {
  const inst = instances[cur.instIdx];
  const legs = [[inst.train, cur.boardStop, finalAlightStop, inst.startDay]];
  let p = cur.prev;
  while (p) {
    legs.push([p.train, p.board, p.alight, p.startDay]);
    p = p.prev;
  }
  legs.reverse();
  return legs;
}
