import { useState } from "react"
import type {
  JourneyView as JourneyData,
  JourneySettingsPatch,
  JourneyTrip as JTrip,
  Transfer,
} from "../services/api.ts"
import { describeError } from "../services/api.ts"
import { decimals, flag, fmt, fmtUnits } from "../utils/format.ts"
import { PickChip, SelfChip } from "./Chips.tsx"
import { OweDetailsModal } from "./OweDetailsModal.tsx"

// The "Trips" tab: every trip in the journey (its members, claim chips,
// + new name) and the add-a-trip picker.
export function TripsTab({
  data,
  cur,
  actions,
  requestClaim,
  openNewName,
  expandedTrips,
  setExpandedTrips,
  addOpen,
  setAddOpen,
  addTrip,
}: {
  data: JourneyData
  cur: string
  actions: { removeTrip: (token: string) => Promise<void> }
  requestClaim: (t: JTrip, input: { member_id: string } | { name: string }, label: string) => void
  openNewName: (t: JTrip) => void
  expandedTrips: Set<string>
  setExpandedTrips: (fn: (prev: Set<string>) => Set<string>) => void
  addOpen: boolean
  setAddOpen: (b: boolean) => void
  addTrip: (token: string) => Promise<void>
}) {
  return (
    <>
      {data.trips.map((t) => (
        <div key={t.token} className="card" style={{ marginBottom: 10 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>
              <a href={`#/t/${t.token}`}>{t.name}</a>
            </h2>
            <span>
              <span className="muted">
                {t.access === "view" ? "view only" : flag(t.settle_currency ?? "") + " " + t.settle_currency}
              </span>
              {t.access === "edit" && (
                <button className="link" style={{ marginLeft: 10 }} onClick={() => actions.removeTrip(t.token)}>
                  remove
                </button>
              )}
            </span>
          </div>
          <div className="row" style={{ flexWrap: "wrap", margin: "8px 0" }}>
            {t.members.map((mm) =>
              data.my_member_ids.includes(mm.id) ? (
                <SelfChip key={mm.id} name={mm.name} linked={mm.linked} />
              ) : (
                <PickChip
                  key={mm.id}
                  name={mm.name}
                  linked={mm.linked}
                  disabled={mm.linked}
                  onClick={() => requestClaim(t, { member_id: mm.id }, mm.name)}
                />
              )
            )}
            <button className="link" onClick={() => openNewName(t)}>
              + new name
            </button>
          </div>
          {t.expenses.length === 0 && <p className="muted">No expenses yet.</p>}
          {t.expenses.length > 0 &&
            (() => {
              const expanded = expandedTrips.has(t.token)
              const shown = expanded ? t.expenses : t.expenses.slice(0, 5)
              const hidden = t.expenses.length - shown.length
              return (
                <>
                  {shown.map((e) => (
                    <div key={e.id} className="expense-row">
                      <a href={`#/t/${t.token}/e/${e.id}`}>{e.name}</a>
                      <span>
                        {fmt(e.total_minor, e.currency)}
                        {e.unassigned_minor > 0 && !e.over && (
                          <span className="badge badge-unassigned">
                            {" "}
                            {fmt(e.unassigned_minor, e.currency)} unassigned
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                  {hidden > 0 && !expanded && (
                    <button
                      className="link"
                      style={{ marginTop: 6 }}
                      onClick={() => {
                        setExpandedTrips((prev) => new Set(prev).add(t.token))
                      }}
                    >
                      show all ({t.expenses.length})
                    </button>
                  )}
                  {hidden > 0 && expanded && (
                    <button
                      className="link"
                      style={{ marginTop: 6 }}
                      onClick={() => {
                        setExpandedTrips((prev) => {
                          const n = new Set(prev)
                          n.delete(t.token)
                          return n
                        })
                      }}
                    >
                      show less
                    </button>
                  )}
                </>
              )
            })()}
        </div>
      ))}
      <button className="link" onClick={() => setAddOpen(!addOpen)}>
        + Add a trip
      </button>
      {addOpen && (
        <div className="card" style={{ marginTop: 8 }}>
          {data.mergeableTrips.length === 0 && <p className="muted">No other trips available.</p>}
          {data.mergeableTrips.map((t) => {
            const ok = t.settle_currency === cur
            return (
              <div key={t.token} className="expense-row">
                <span className={ok ? "" : "muted"}>{t.name}</span>
                {ok ? (
                  <button className="link" onClick={() => addTrip(t.token)}>
                    add
                  </button>
                ) : (
                  <span className="muted">
                    settles in {t.settle_currency} — journey is {cur}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

// Detail view for a journey owe-card: one tab per trip, showing each trip's
// contribution (expenses + settlements) to the pair's net. The same "math"
// the trip page shows, but per trip — so you can see where each entry comes from.
export function DetailModal({
  transfer,
  currency,
  members,
  onClose,
}: {
  transfer: Transfer
  currency: string
  members: { token: string; members: { id: string; name: string }[] }[]
  onClose: () => void
}) {
  const { from, to, parts } = transfer
  const [active, setActive] = useState(parts[0]?.trip_token ?? "")
  const [showRate, setShowRate] = useState(false)
  const activePart = parts.find((p) => p.trip_token === active)
  // Resolve a member id to its name, scanning across the trip's member lists.
  const nameOf = (id: string) => {
    for (const t of members) {
      const m = t.members.find((mm) => mm.id === id)
      if (m) return m.name
    }
    return "?"
  }
  const entries = activePart?.log ?? []
  return (
    <OweDetailsModal
      title={`${from} · ${fmtUnits(transfer.amount, currency)}`}
      currency={currency}
      entries={entries}
      labelFor={(en) =>
        en.kind === "settlement"
          ? `${nameOf(en.sign > 0 ? (activePart?.from_member ?? "") : (activePart?.to_member ?? ""))} paid ${nameOf(en.sign > 0 ? (activePart?.to_member ?? "") : (activePart?.from_member ?? ""))}`
          : en.label
      }
      showRate={showRate}
      onShowRate={() => setShowRate(!showRate)}
      footer={
        <div className="math-row math-total">
          <span>= net</span>
          <span className="amt">
            {activePart
              ? `${activePart.against ? `${to} owes ${from}` : `${from} owes ${to}`} ${fmtUnits(activePart.amount, currency)}`
              : ""}
          </span>
        </div>
      }
      tabs={parts.map((p) => ({ key: p.trip_token, label: p.trip_name }))}
      activeTab={active}
      onTab={(k) => {
        setActive(k)
        setShowRate(false)
      }}
      onClose={onClose}
    />
  )
}

// Settle a journey card: tick any trips, then record one Settlement per ticked
// trip for that trip's full debt, in that trip's own direction, between its own
// Members. Real money only moves once, for the net of the ticked trips; recording
// each trip in full is what makes every ticked trip balance exactly zero.
export function MarkPaidModal({
  transfer,
  currency,
  trips,
  settlePart,
  onClose,
  onDone,
}: {
  transfer: Transfer
  currency: string
  trips: JTrip[]
  settlePart: (p: Transfer["parts"][number], minor: number) => Promise<unknown>
  onClose: () => void
  onDone: () => void
}) {
  const { from, to, parts } = transfer // card direction: `from` owes `to` overall
  const [picked, setPicked] = useState<Set<string>>(() => new Set(parts.map((p) => p.trip_token)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const chosen = parts.filter((p) => picked.has(p.trip_token))
  const all = chosen.length === parts.length
  // net in the card's direction; negative means the ticked trips lean the other way
  const net = chosen.reduce((s, p) => s + (p.against ? -p.amount : p.amount), 0)
  const half = 0.5 / 10 ** decimals(currency)
  const label =
    Math.abs(net) < half
      ? "even, no money changes hands"
      : net > 0
        ? `${from} pays ${to} ${fmtUnits(net, currency)}`
        : `${to} pays ${from} ${fmtUnits(-net, currency)}`
  const canEdit = (tt: string) => trips.find((t) => t.token === tt)?.access === "edit"
  const blocked = chosen.filter((p) => !canEdit(p.trip_token))
  const toggle = (tt: string, on: boolean) => {
    const next = new Set(picked)
    if (on) next.add(tt)
    else next.delete(tt)
    setPicked(next)
  }

  const submit = async () => {
    setBusy(true)
    setError("")
    try {
      for (const p of chosen) {
        const minor = Math.round(p.amount * 10 ** decimals(currency))
        if (minor <= 0) continue
        await settlePart(p, minor)
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : "error")
      setBusy(false)
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          Settle {from} ↔ {to}
        </h3>
        <label className="expense-row">
          <span>
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => setPicked(new Set(e.target.checked ? parts.map((p) => p.trip_token) : []))}
            />{" "}
            All trips
          </span>
          <b>
            {from} owes {to} {fmtUnits(transfer.amount, currency)}
          </b>
        </label>
        {parts.map((p) => (
          <label key={p.trip_token} className="expense-row" style={{ paddingLeft: 22 }}>
            <span>
              <input
                type="checkbox"
                checked={picked.has(p.trip_token)}
                onChange={(e) => toggle(p.trip_token, e.target.checked)}
              />{" "}
              {p.trip_name}
            </span>
            <span className={p.against ? "muted" : ""}>
              {p.against ? `${to} owes ${from}` : `${from} owes ${to}`} {fmtUnits(p.amount, currency)}
            </span>
          </label>
        ))}
        {chosen.some((p) => p.against) && chosen.some((p) => !p.against) && (
          <p className="muted">
            Each ticked trip is recorded in full so it ends at zero; in real life only the net changes hands.
          </p>
        )}
        {blocked.length > 0 && (
          <p className="warn">
            Pick your name in {blocked.map((p) => p.trip_name).join(", ")} first — you can only record payments in trips
            you've joined.
          </p>
        )}
        {error && <div className="error">{error}</div>}
        <div className="modal-btns">
          <button className="link" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || chosen.length === 0 || blocked.length > 0} onClick={submit}>
            Record: {label}
          </button>
        </div>
      </div>
    </div>
  )
}

// Journey settings: rename, read-only shared currency (inherited from the
// trips), and dissolve. Removing trips / merging people lives on the tabs.
export function JourneySettings({
  data,
  patchSettings,
  dissolve,
  setShow,
}: {
  data: JourneyData
  patchSettings: (p: JourneySettingsPatch) => Promise<void>
  dissolve: (name: string) => Promise<unknown>
  setShow: (b: boolean) => void
}) {
  const j = data.journey
  const [delName, setDelName] = useState("")
  const [funErr, setFunErr] = useState("")
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <div className="field">
        <label className="field-label">Name</label>
        <input
          className="wide"
          defaultValue={j.name}
          onBlur={async (e) => {
            if (e.target.value.trim() && e.target.value !== j.name) {
              await patchSettings({ name: e.target.value.trim() })
            }
          }}
        />
      </div>
      <div className="field">
        <label className="field-label">Settlement currency</label>
        <div className="locked-field">
          {flag(j.settle_currency)} {j.settle_currency}
        </div>
        <p className="muted">Shared by every trip in the journey</p>
      </div>
      <div className="field">
        <label className="field-label">🎁 Journey Wrapped</label>
        <label className="member-chip" style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={j.fun_leaderboard}
            onChange={async (e) => {
              setFunErr("")
              try {
                await patchSettings({ fun_leaderboard: e.target.checked })
              } catch (err) {
                setFunErr(describeError(err))
              }
            }}
          />
          Show the Journey Wrapped tab with silly awards
        </label>
        <p className="muted">Awards unlock after the last trip ends.</p>
        {funErr && (
          <p className="error" style={{ margin: "6px 0 0" }}>
            {funErr}
          </p>
        )}
      </div>
      <div className="field">
        <label className="field-label error">Danger zone</label>
        <div className="row">
          <input
            value={delName}
            placeholder={`Type "${j.name}" to dissolve`}
            onChange={(e) => setDelName(e.target.value)}
          />
          <button
            className="danger"
            disabled={delName !== j.name}
            onClick={async () => {
              await dissolve(delName)
              location.hash = "#/"
            }}
          >
            Dissolve journey
          </button>
        </div>
        <p className="muted">Dissolving ungroups the trips — they keep their own data.</p>
      </div>
      <button onClick={() => setShow(false)}>Close</button>
    </div>
  )
}
