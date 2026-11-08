import React from "react";
import { Avatar } from "./OweCard.tsx";

// Clickable chip for picking/claiming a Member. `locked` means the member is
// tied to a signed-in account — rendered as a 🔒 pill; `disabled` for the
// "can't claim a linked member without signing in" gate.
export function PickChip({ name, linked, disabled, onClick }: {
  name: string; linked: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button className="member-chip" disabled={disabled} onClick={onClick}>
      <Avatar name={name} />{name}{linked && <span className="pill">🔒</span>}
    </button>
  );
}

// Static chip for "you" — the member(s) this session has claimed.
export function SelfChip({ name, linked }: { name: string; linked: boolean }) {
  return <span className="member-chip"><Avatar name={name} /><b>{name}</b>{linked ? " ✓" : ""}</span>;
}
