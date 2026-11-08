import React, { useEffect, useRef, useState } from "react";

// A transient confirmation bar. Fire it from anywhere with showSnack();
// SnackRoot (mounted once in App) is the only thing that renders it, so it
// survives hash-route changes — an add-expense snack shows while the user
// is already landing on the new expense page.
type Kind = "success" | "error";
type SnackMsg = { id: number; text: string; kind: Kind; duration: number };

let bus: ((m: SnackMsg) => void) | null = null;
let seq = 0;

export function showSnack(text: string, opts?: { kind?: Kind; duration?: number }) {
  bus?.({ id: ++seq, text, kind: opts?.kind ?? "success", duration: opts?.duration ?? 3000 });
}

const EXIT = 260; // ms exit animation

export default function SnackRoot() {
  const [snacks, setSnacks] = useState<SnackMsg[]>([]);
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    bus = (m) => {
      setSnacks((prev) => [...prev, m]);
      const t = setTimeout(() => startExit(m.id), m.duration);
      timers.current.set(m.id, t);
    };
    return () => { bus = null; timers.current.forEach(clearTimeout); };
  }, []);

  const startExit = (id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setLeaving((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setSnacks((prev) => prev.filter((s) => s.id !== id));
      setLeaving((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }, EXIT);
  };

  return (
    <div className="snack-layer">
      {snacks.map((s) => (
        <div
          key={s.id}
          className={`snack snack-${s.kind}${leaving.has(s.id) ? " snack-out" : ""}`}
          onClick={() => startExit(s.id)}
        >
          <span className="snack-dot" />
          <span>{s.text}</span>
        </div>
      ))}
    </div>
  );
}
