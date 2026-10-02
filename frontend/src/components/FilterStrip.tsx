import type { FilterInfo } from "../types";

interface Props {
  filters: FilterInfo[];
  selected: string;
  onSelect: (k: string) => void;
}

export function FilterStrip({ filters, selected, onSelect }: Props) {
  return (
    <div className="flex gap-2 overflow-x-auto py-2 px-1">
      {filters.map((f) => (
        <button
          key={f.key}
          onClick={() => onSelect(f.key)}
          className={`flex-shrink-0 px-4 py-2 rounded-full text-sm border transition ${
            selected === f.key
              ? "bg-brick text-white border-brick shadow"
              : "bg-white/80 text-brown border-pink hover:bg-pink/40"
          }`}
        >
          {f.name}
        </button>
      ))}
    </div>
  );
}
