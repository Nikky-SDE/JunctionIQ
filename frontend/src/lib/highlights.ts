import { duration, hhmm } from "./format.ts";
import type { Journey } from "./types.ts";

export interface Highlight {
  id: string;
  label: string;
  pick: (js: Journey[]) => Journey | undefined;
  value: (j: Journey) => string;
}

const minBy = (js: Journey[], key: (j: Journey) => number) =>
  js.reduce<Journey | undefined>(
    (b, j) => (!b || key(j) < key(b) || (key(j) === key(b) && j.rank < b.rank) ? j : b),
    undefined
  );

export const HIGHLIGHTS: Highlight[] = [
  { id: "arrival", label: "Earliest arrival", pick: (js) => minBy(js, (j) => j.rank), value: (j) => hhmm(j.arrival_datetime) },
  { id: "duration", label: "Shortest trip", pick: (js) => minBy(js, (j) => j.duration_minutes), value: (j) => duration(j.duration_minutes) },
  {
    id: "transfers",
    label: "Fewest changes",
    pick: (js) => minBy(js, (j) => j.transfer_count),
    value: (j) => (j.transfer_count ? `${j.transfer_count} change${j.transfer_count > 1 ? "s" : ""}` : "Direct"),
  },
  { id: "waiting", label: "Least waiting", pick: (js) => minBy(js, (j) => j.waiting_minutes), value: (j) => duration(j.waiting_minutes) },
];

/** Badge labels per journey id, for the cards. */
export function highlightBadges(js: Journey[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const h of HIGHLIGHTS) {
    const j = h.pick(js);
    if (j) m.set(j.id, [...(m.get(j.id) ?? []), h.label]);
  }
  return m;
}
