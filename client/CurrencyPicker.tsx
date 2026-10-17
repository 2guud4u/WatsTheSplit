import React, { useEffect, useRef, useState } from "react";
import { flag, CURRENCY_COUNTRIES } from "./api.ts";

// Searchable currency select: matches code or country name.
export function CurrencyPicker({ value, options, onChange, placeholder = "— pick —" }: {
  value: string; options: string[]; onChange: (code: string) => void; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDoc = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const needle = q.trim().toLowerCase();
  const filtered = !needle ? options : options.filter((c) =>
    c.toLowerCase().includes(needle) ||
    (CURRENCY_COUNTRIES[c] ?? "").toLowerCase().includes(needle));

  return (
    <div className="cur-picker" ref={ref}>
      <button type="button" className={`cur-btn${value ? "" : " muted"}`}
        onClick={() => { setOpen(!open); setQ(""); }}>
        {value ? `${flag(value)} ${value}` : placeholder} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="cur-pop">
          <input ref={inputRef} className="cur-search" placeholder="currency or country…"
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered.length) { onChange(filtered[0]); setOpen(false); }
              if (e.key === "Escape") setOpen(false);
            }} />
          <div className="cur-list">
            {filtered.map((c) => (
              <button key={c} type="button" className={`cur-opt${c === value ? " active" : ""}`}
                onClick={() => { onChange(c); setOpen(false); }}>
                <span className="cur-code">{flag(c)} {c}</span>
                <span className="cur-name">{CURRENCY_COUNTRIES[c] ?? ""}</span>
              </button>
            ))}
            {filtered.length === 0 && <div className="muted cur-none">no match</div>}
          </div>
        </div>
      )}
    </div>
  );
}
