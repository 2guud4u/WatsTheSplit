import { useState } from "react"
import type { DateRange } from "react-day-picker"
import type { TripView as TripData, TripSettingsPatch } from "../services/api.ts"
import { describeError } from "../services/api.ts"
import { flag } from "../utils/format.ts"
import { PaymentForm } from "./PaymentForm.tsx"
import { RangePicker } from "./RangePicker.tsx"

function SettingsDates({
  t,
  actions,
}: {
  t: { start_date: string | null; end_date: string | null }
  actions: { patchSettings: (p: TripSettingsPatch) => Promise<void> }
}) {
  const parse = (s: string | null) => (s ? new Date(s + "T00:00:00") : undefined)
  const [range, setRange] = useState<DateRange | undefined>({ from: parse(t.start_date), to: parse(t.end_date) })
  const save = async (r: DateRange | undefined) => {
    await actions.patchSettings({
      start_date: r?.from ? r.from.toISOString().slice(0, 10) : null,
      end_date: r?.to ? r.to.toISOString().slice(0, 10) : null,
    })
  }
  return (
    <div>
      <RangePicker value={range} onChange={setRange} onCommit={save} />
      {(range?.from || range?.to) && (
        <button
          className="link"
          onClick={async () => {
            setRange(undefined)
            await save(undefined)
          }}
        >
          Clear dates
        </button>
      )}
    </div>
  )
}

export function Settings({
  data,
  token,
  currencies,
  actions,
  onSwitch,
  setShow,
  reloadMe,
}: {
  data: TripData
  token: string
  currencies: string[]
  actions: {
    patchSettings: (p: TripSettingsPatch) => Promise<void>
    addMember: (n: string) => Promise<void>
    removeMember: (id: string) => Promise<void>
    deleteTrip: (n: string) => Promise<void>
    savePayment: (p: { phone: string | null; venmo: string | null; cash_app: string | null }) => Promise<void>
  }
  onSwitch: (id: string, name: string) => void
  setShow: (b: boolean) => void
  reloadMe: () => void
}) {
  const t = data.trip
  const [pw, setPw] = useState("")
  const [funErr, setFunErr] = useState("")
  const [newMember, setNewMember] = useState("")
  const [delName, setDelName] = useState("")

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <div className="field">
        <label className="field-label">Name</label>
        <input
          className="wide"
          defaultValue={t.name}
          onBlur={async (e) => {
            if (e.target.value !== t.name) {
              await actions.patchSettings({ name: e.target.value })
            }
          }}
        />
      </div>
      <div className="field">
        <label className="field-label">Dates</label>
        <SettingsDates t={t} actions={actions} />
      </div>
      <div className="row">
        <div className="field">
          <label className="field-label">Trip currency</label>
          <div className="locked-field">
            {flag(t.trip_currency)} {t.trip_currency}
          </div>
        </div>
        <div className="field">
          <label className="field-label">Settlement currency</label>
          <div className="locked-field">
            {flag(t.settle_currency)} {t.settle_currency}
          </div>
        </div>
      </div>
      <p className="muted" style={{ marginTop: -6 }}>
        Currencies locked at creation
      </p>

      <div className="field">
        <label className="field-label">🎁 Trip Wrapped</label>
        {data.is_creator ? (
          <>
            <label className="member-chip" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={t.fun_leaderboard}
                onChange={async (e) => {
                  setFunErr("")
                  try {
                    await actions.patchSettings({ fun_leaderboard: e.target.checked })
                  } catch (err) {
                    setFunErr(describeError(err))
                  }
                }}
              />
              Show the Trip Wrapped tab with silly awards
            </label>
            {funErr && (
              <p className="error" style={{ margin: "6px 0 0" }}>
                {funErr}
              </p>
            )}
          </>
        ) : (
          <p className="muted">Only the trip creator can toggle this.</p>
        )}
      </div>

      <div className="field">
        <label className="field-label">Trip password</label>
        <div className="row">
          <input type="password" value={pw} placeholder="New trip password" onChange={(e) => setPw(e.target.value)} />
          <button
            disabled={!pw}
            onClick={async () => {
              await actions.patchSettings({ password: pw })
              setPw("")
            }}
          >
            Change
          </button>
        </div>
        <p className="muted">
          Every trip keeps a password. Changing it re-prompts every device except signed-in members.
        </p>
      </div>

      <div className="field">
        <label className="field-label">Members</label>
        {data.members.map((m) => (
          <div key={m.id} className="expense-row">
            <span>
              {m.name} {m.linked && <span className="pill">🔒 linked</span>}{" "}
              {m.is_me && <span className="pill">(you)</span>}
            </span>
            <span>
              {!m.is_me && !m.linked && (
                <button className="link" onClick={() => onSwitch(m.id, m.name)}>
                  this is me
                </button>
              )}
              {!m.used && !m.is_me && (
                <button
                  className="link danger"
                  onClick={async () => {
                    await actions.removeMember(m.id)
                  }}
                >
                  remove
                </button>
              )}
            </span>
          </div>
        ))}
        <div className="row">
          <input
            className="wide"
            value={newMember}
            placeholder="Add a placeholder member"
            onChange={(e) => setNewMember(e.target.value)}
          />
          <button
            disabled={!newMember.trim()}
            onClick={async () => {
              await actions.addMember(newMember.trim())
              setNewMember("")
            }}
          >
            Add
          </button>
        </div>
      </div>

      <div className="field">
        <label className="field-label">How to pay you</label>
        {data.me ? (
          <PaymentForm initial={data.me.payment} onSaved={() => reloadMe()} onSave={(p) => actions.savePayment(p)} />
        ) : (
          <p className="muted">Pick your name first, then add how to pay you.</p>
        )}
      </div>

      <div className="field">
        <label className="field-label error">Danger zone</label>
        <div className="row">
          <input
            value={delName}
            placeholder={`Type "${t.name}" to delete`}
            onChange={(e) => setDelName(e.target.value)}
          />
          <button
            className="danger"
            disabled={delName !== t.name}
            onClick={async () => {
              await actions.deleteTrip(delName)
              location.hash = "#/"
            }}
          >
            Delete trip
          </button>
        </div>
      </div>
      <button onClick={() => setShow(false)}>Close</button>
    </div>
  )
}
