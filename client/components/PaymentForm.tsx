import React, { useState } from "react"
import { showSnack } from "./Snack.tsx"

// The "How to pay you?" form: three optional slots (phone, Venmo, Cash App).
// Purely controlled — the caller decides where the save lands (account or
// member row) via `onSave`. `initial` is used for pre-fill (Settings, or the
// prompt if already set).

export type PaymentValues = { phone: string | null; venmo: string | null; cash_app: string | null }

export function PaymentForm({
  initial,
  onSaved,
  onSave,
  saveLabel = "Save",
}: {
  initial?: PaymentValues | null
  onSaved?: () => void
  onSave: (p: PaymentValues) => Promise<void>
  saveLabel?: string
}) {
  const [phone, setPhone] = useState(initial?.phone ?? "")
  const [venmo, setVenmo] = useState(initial?.venmo ?? "")
  const [cash_app, setCashApp] = useState(initial?.cash_app ?? "")
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      const p = {
        phone: phone.trim() || null,
        venmo: venmo.trim() || null,
        cash_app: cash_app.trim() || null,
      }
      await onSave(p)
      showSnack("How to pay you saved")
      onSaved?.()
    } catch (e) {
      showSnack(e instanceof Error ? e.message : "Couldn't save", { kind: "error" })
    }
    setBusy(false)
  }

  return (
    <div>
      <div className="field">
        <label className="field-label">Phone (SMS / text)</label>
        <input
          type="tel"
          className="wide"
          value={phone}
          placeholder="555-0100"
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label">Venmo</label>
        <input className="wide" value={venmo} placeholder="@you" onChange={(e) => setVenmo(e.target.value)} />
      </div>
      <div className="field">
        <label className="field-label">Cash App</label>
        <input
          className="wide"
          value={cash_app}
          placeholder="$you or 555-0100"
          onChange={(e) => setCashApp(e.target.value)}
        />
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={save}>
          {busy ? "…" : saveLabel}
        </button>
      </div>
    </div>
  )
}

// Modal wrapper for the "How to pay you?" prompt. Save closes it via
// onSaved (the caller's close handler).
export function PaymentPromptModal({
  initial,
  onClose,
  onSaved,
  onSave,
}: {
  initial?: PaymentValues | null
  onClose: () => void
  onSaved?: () => void
  onSave: (p: PaymentValues) => Promise<void>
}) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>How to pay you?</h3>
        <p className="muted">
          Others in the trip use this to send you their balance. Leave blank to skip — you can add it later in Settings.
        </p>
        <PaymentForm initial={initial} onSaved={onSaved} onSave={onSave} />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="link" onClick={onClose}>
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}

// Global "seen" flag, shared by the join prompt and end-of-trip prompt.
// Once dismissed, the prompt never shows again for this user.
const SEEN_KEY = "wts_payment_prompt_seen"
export function paymentPromptSeen(): boolean {
  return localStorage.getItem(SEEN_KEY) === "1"
}
export function markPaymentPromptSeen(): void {
  localStorage.setItem(SEEN_KEY, "1")
}
export function paymentHasInfo(
  p: { phone: string | null; venmo: string | null; cash_app: string | null } | null | undefined
): boolean {
  if (!p) return false
  return !!(p.phone || p.venmo || p.cash_app)
}
