import React from "react";
import { DayPicker, type DateRange } from "react-day-picker";

// Drag-to-select range picker over react-day-picker. A plain click starts or
// finishes a range; a drag across days commits immediately on pointerup. In
// range mode. Dates are compared at day granularity.
export function RangePicker({ value, onChange, onCommit }: { value: DateRange | undefined; onChange: (r: DateRange | undefined) => void; onCommit?: (r: DateRange | undefined) => void }) {
  const start = React.useRef<Date | null>(null);
  const moved = React.useRef(false);
  const suppress = React.useRef(false); // swallow the click DayPicker fires after pointerup

  const dayAt = (e: React.PointerEvent): Date | null => {
    // During pointer capture e.target stays on the wrapper; hit-test instead.
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-day]");
    const ds = el?.getAttribute("data-day");
    return ds ? new Date(ds + "T00:00:00") : null;
  };

  const onDown = (e: React.PointerEvent) => {
    const d = dayAt(e);
    if (!d) return;
    start.current = d;
    moved.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const d = dayAt(e);
    if (!d || d.getTime() === s.getTime()) return;
    moved.current = true;
    onChange(s <= d ? { from: s, to: d } : { from: d, to: s });
  };
  const onUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    suppress.current = true;
    if (moved.current) { moved.current = false; onCommit?.(value); return; }
    // Plain click: finish a pending range, else start a new one.
    let next: DateRange | undefined;
    if (value?.from && !value.to && s.getTime() !== value.from.getTime()) {
      next = s > value.from ? { from: value.from, to: s } : { from: s, to: value.from };
    } else {
      next = { from: s, to: undefined };
    }
    onChange(next);
    onCommit?.(next);
  };

  return (
    <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      onPointerCancel={onUp} style={{ touchAction: "pan-y" }}>
      <DayPicker mode="range" selected={value} weekStartsOn={1}
        onSelect={(r) => { if (suppress.current) { suppress.current = false; return; } onChange(r); }} />
    </div>
  );
}
