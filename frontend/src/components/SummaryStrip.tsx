import { HIGHLIGHTS, highlightBadges, type Highlight } from "@/lib/highlights";
import { hhmm } from "@/lib/format";
import type { Journey } from "@/lib/types";

export { HIGHLIGHTS, highlightBadges, type Highlight };

export function SummaryStrip({
  journeys,
  selectedId,
  onPick,
}: {
  journeys: Journey[];
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  if (journeys.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {HIGHLIGHTS.map((h) => {
        const j = h.pick(journeys)!;
        const on = j.id === selectedId;
        return (
          <button
            key={h.id}
            onClick={() => onPick(j.id)}
            className={`card min-w-0 px-3 py-2.5 text-left transition hover:shadow-lift ${
              on ? "border-brand-500! ring-1 ring-brand-500 dark:border-brand-400!" : ""
            }`}
          >
            <div className="truncate text-[11px] font-medium text-slate-500 dark:text-slate-400">{h.label}</div>
            <div className="tabular truncate text-base font-bold">{h.value(j)}</div>
            <div className="tabular truncate text-[11px] text-slate-400">
              #{j.rank} · {hhmm(j.departure_datetime)}→{hhmm(j.arrival_datetime)}
            </div>
          </button>
        );
      })}
    </div>
  );
}
