import React, { useState } from "react";
import { fmtUnits } from "./api.ts";

const AVATAR_COLORS = ["#b56a4c","#7a9b6d","#c9a25e","#8f7fae","#b07575","#7d9aa8","#c9b458","#a08a6e","#6d7f9e"];
export function Avatar({ name }: { name: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return <span className="avatar" style={{ background: AVATAR_COLORS[h % AVATAR_COLORS.length] }}>
    {name.trim()[0]?.toUpperCase() ?? "?"}
  </span>;
}

export function memberName(members: { id: string; name: string }[], id: string) {
  return members.find((m) => m.id === id)?.name ?? "?";
}

// One owe-card: avatar + name + signed amount, optional confirm/details.
// Trips wire onConfirm to settlements; journeys pass nothing (settle in trips).
export function OweCard({ name, amount, currency, dir, onConfirm, onDetails }: {
  name: string; amount: number; currency: string;
  dir: "in" | "out";
  onConfirm?: () => void;
  onDetails?: () => void;
}) {
  return (
    <div className="owe-card">
      <Avatar name={name} />
      <span className="owe-info">
        <b>{name}</b>
        <span className={`amt ${dir === "in" ? "net-pos" : "net-neg"}`}>
          {fmtUnits(amount, currency)}
        </span>
      </span>
      {onConfirm && <button className="owe-confirm" onClick={onConfirm}>✓ confirm paid</button>}
      {onDetails && <button className="math-link" onClick={onDetails}>details</button>}
    </div>
  );
}
