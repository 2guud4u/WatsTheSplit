import React from "react";
import { fmt, fmtUnits, decimals } from "../utils/format.ts";
import type { SignedBalanceLogEntry } from "../services/api.ts";

// The "how did this net come about" modal for an owe-card: the list of
// entries (one per expense — share -> converted amount, optionally the rate
// calculation — and one per settlement), plus a net line. Names are resolved
// through `labelFor` so the caller can look them up in whatever member list it
// has (one trip's, or across several trips). `tabs` (one per trip, on the
// journey page) lets the caller switch which trip's entries are shown;
// switching tabs resets the rate toggle.
export function OweDetailsModal({ title, currency, entries, labelFor, showRate,
  onShowRate, footer, onClose, tabs, activeTab, onTab }: {
  title: React.ReactNode;
  currency: string;
  entries: SignedBalanceLogEntry[];
  labelFor: (en: SignedBalanceLogEntry) => string;
  showRate: boolean;
  onShowRate: () => void;
  footer: React.ReactNode;
  onClose: () => void;
  tabs?: { key: string; label: string }[];
  activeTab?: string;
  onTab?: (k: string) => void;
}) {
  const dec = decimals(currency);
  // the Locked Rate, trimmed to 2 significant figures (the stored value is
  // untouched; the UI just stops printing 15 decimals)
  const rate = (r: number) => r.toPrecision(2).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  const hasRate = entries.some((en) => en.kind === "expense" && en.rate !== null && en.rate !== undefined);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {tabs && tabs.length > 1 && (
          <div className="tabs">
            {tabs.map((t) => (
              <button key={t.key} className={activeTab === t.key ? "active" : ""}
                onClick={() => onTab?.(t.key)}>{t.label}</button>
            ))}
          </div>
        )}
        <div className="math-list">
          {entries.map((en, i) => (
            <div key={i} className="math-row">
              {(() => {
                const delta = en.kind === "expense"
                  ? en.sign * (en.converted ?? 0) * 10 ** dec
                  : en.sign * (en.amount_minor ?? 0);
                const signChar = delta < 0 ? "−" : "+";
                const result = fmtUnits(Math.abs(delta) / 10 ** dec, currency);
                const prefix = en.kind === "expense"
                  ? showRate && en.rate !== null && en.rate !== undefined
                    ? `${fmt(en.share_minor ?? 0, en.currency ?? "USD")} × ${rate(en.rate)} = `
                    : `${fmt(en.share_minor ?? 0, en.currency ?? "USD")} → `
                  : "";
                const amtText = en.kind === "expense" ? `${prefix}${result}` : result;
                return (
                  <>
                    <span>{signChar} {labelFor(en)}</span>
                    <span className="amt muted">{amtText}</span>
                  </>
                );
              })()}
            </div>
          ))}
          {footer}
        </div>
        <div className="modal-btns">
          {hasRate && (
            <button className="link" onClick={onShowRate}>
              {showRate ? "hide exchange math" : "show exchange math"}
            </button>
          )}
          <button onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  );
}
