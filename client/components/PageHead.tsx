import React from "react";

// Title row with a "← back" link, used at the top of every screen.
export function PageHead({ title, back }: { title: React.ReactNode; back: { href: string; label: string } }) {
  return (
    <div className="row" style={{ justifyContent: "space-between" }}>
      <h1 style={{ marginBottom: 4 }}>{title}</h1>
      <a href={back.href} className="muted">← {back.label}</a>
    </div>
  );
}

// Horizontal tab bar; renders one button per [key, label] pair.
export function Tabs<T extends string>({ value, onChange, tabs }: {
  value: T; onChange: (t: T) => void; tabs: readonly (readonly [T, string])[];
}) {
  return (
    <div className="tabs">
      {tabs.map(([k, label]) => (
        <button key={k} className={value === k ? "active" : ""} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}
