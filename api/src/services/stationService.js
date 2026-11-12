import { readFile } from "node:fs/promises";

const CANONICAL_ALIASES = {
  MAS: ["CHENNAI CENTRAL", "CHENNAI", "MADRAS", "MADRAS CENTRAL", "PURATCHI THALAIVAR DR. MGR CTL"],
  MS: ["CHENNAI EGMORE", "CHENNAI", "MADRAS"],
  MMCT: ["MUMBAI CENTRAL", "MUMBAI", "BOMBAY", "BOMBAY CENTRAL"],
  CSMT: ["C SHIVAJI MAH T", "CHHATRAPATI SHIVAJI MAHARAJ TERMINUS", "MUMBAI", "BOMBAY", "VT", "VICTORIA TERMINUS"],
  BDTS: ["BANDRA TERMINUS", "MUMBAI", "BOMBAY"],
  LTT: ["LOKMANYA TILAK T", "MUMBAI", "BOMBAY"],
  HWH: ["HOWRAH JN", "HOWRAH", "KOLKATA", "CALCUTTA"],
  SDAH: ["SEALDAH", "KOLKATA", "CALCUTTA"],
  KOAA: ["KOLKATA TERMINAL", "KOLKATTA TERMINAL", "KOLKATA", "CALCUTTA", "CHITPUR"],
  SHM: ["SHALIMAR", "KOLKATA", "CALCUTTA"],
  SBC: ["KSR BENGALURU", "BENGALURU", "BANGALORE", "BANGALORE CITY", "BANGALORE CITY JN"],
  YPR: ["YESVANTPUR JN", "BENGALURU", "BANGALORE"],
  BNC: ["BANGALORE CANT", "BENGALURU", "BANGALORE"],
  NDLS: ["NEW DELHI", "DELHI"],
  DLI: ["DELHI JN.", "OLD DELHI", "DELHI"],
  NZM: ["HAZRAT NIZAMUDDIN", "DELHI", "NIZAMUDDIN"],
  ANVT: ["ANAND VIHAR TERMINAL", "DELHI", "ANAND VIHAR"],
  BSB: ["VARANASI", "VARANASI JN", "BANARAS", "KASHI"],
  BNRS: ["BANARAS", "MANDUADIH", "VARANASI"],
  PRYJ: ["PRAYAGRAJ", "PRAYAGRAJ JN", "ALLAHABAD", "ALLAHABAD JN"],
  AY: ["AYODHYA", "AYODHYA DHAM"],
  AYC: ["AYODHYA CANTT", "FAIZABAD"],
  PNBE: ["PATNA JN", "PATNA", "PATLIPUTRA"],
  ADI: ["AHMEDABAD JN", "AHMEDABAD"],
  PUNE: ["PUNE JN", "PUNE", "POONA"],
  HYB: ["HYDERABAD DECCAN", "HYDERABAD", "NAMPILLY"],
  SC: ["SECUNDERABAD JN", "SECUNDERABAD", "HYDERABAD"],
  TVC: ["THIRUVANANTHAPURAM CENTRAL", "TRIVANDRUM", "TRIVANDRUM CENTRAL"],
};

export class StationService {
  constructor(stations = [], source = "memory") {
    this.stations = [];
    this.byCode = new Map();
    this.source = source;
    if (stations.length) this.load(stations, source);
  }

  load(stations, source = "memory") {
    this.stations = stations.map((s) => {
      const code = s.code.toUpperCase();
      let names = Array.isArray(s.all_known_names) ? [...s.all_known_names] : [s.name];
      if (code === "BPR") names = names.filter((n) => !n.includes("BADARPUR"));
      if (code === "MGR") names = names.filter((n) => !n.includes("PURATCHI THALAIVAR"));

      const extras = CANONICAL_ALIASES[code] || [];
      const set = new Set([...names, ...extras]);
      return {
        ...s,
        all_known_names: Array.from(set),
      };
    });
    this.byCode = new Map(this.stations.map((s) => [s.code.toUpperCase(), s]));
    this.source = source;
  }

  get size() {
    return this.stations.length;
  }

  all() {
    return this.stations;
  }

  get(code) {
    if (!code) return undefined;
    return this.byCode.get(String(code).trim().toUpperCase());
  }

  static hit(s) {
    return {
      code: s.code,
      name: s.name,
      label: `${s.name} (${s.code})`,
      train_count: s.train_count || 0,
    };
  }

  search(query, limit = 10) {
    const q = String(query || "").trim().toUpperCase();
    if (!q) return [];

    const matches = [];
    for (const s of this.stations) {
      const code = s.code.toUpperCase();
      const name = (s.name || "").toUpperCase();
      const aliases = (s.all_known_names || []).map((n) => n.toUpperCase());

      let tier = -1;
      if (code === q) {
        tier = 0; // exact code match
      } else if (code.startsWith(q)) {
        tier = 1; // code prefix match
      } else if (name.startsWith(q) || aliases.some((a) => a.startsWith(q))) {
        tier = 2; // name or alias prefix match
      } else if (name.includes(q) || aliases.some((a) => a.includes(q))) {
        tier = 3; // substring match
      }

      if (tier !== -1) {
        matches.push({ s, tier });
      }
    }

    matches.sort((a, b) => a.tier - b.tier || (b.s.train_count || 0) - (a.s.train_count || 0) || (a.s.code < b.s.code ? -1 : 1));
    return matches.slice(0, limit).map((m) => StationService.hit(m.s));
  }
}

export async function loadStationsFromFile(path) {
  const content = await readFile(path, "utf8");
  return JSON.parse(content);
}
