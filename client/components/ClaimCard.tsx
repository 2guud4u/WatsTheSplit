import { useState } from "react"
import type { ClaimInput, TripView as TripData } from "../services/api.ts"
import { PickChip, SelfChip } from "./Chips.tsx"
import { SignInButton } from "./SignIn.tsx"

// "Who are you?" claim / switch card. Defined at module level (NOT inside
// TripView's render) so React keeps the same component instance across
// re-renders: the name field is typed by an invitee, and an inline component
// would be rebuilt on every keystroke (setNewName → re-render), remounting
// the <input> and dropping its focus — the keyboard goes away on mobile
// after each character. The `newName` draft lives in this component.
export function ClaimCard({
  data,
  readOnly,
  requestSwitch,
  load,
  reloadMe,
  switching = false,
  onCancel,
}: {
  data: TripData
  readOnly: boolean
  requestSwitch: (input: ClaimInput, label: string) => void
  load: () => Promise<void>
  reloadMe: () => void
  switching?: boolean
  onCancel?: () => void
}) {
  const [newName, setNewName] = useState("")
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{switching ? "Switch who you are" : "Who are you?"}</h2>
      <p className="muted">
        {switching ? (
          "Pick your name — you'll act as them in this trip."
        ) : (
          <>Pick your name or add a new one{readOnly ? " — or just browse below" : ""}.</>
        )}{" "}
        {!data.signed_in && (
          <>
            Without signing in, <b>anyone with the trip link can pick your name later</b>.
          </>
        )}
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        {data.members.map((m) =>
          m.is_me ? (
            <SelfChip key={m.id} name={m.name} linked={m.linked} crown={m.id === data.creator_id} />
          ) : (
            <PickChip
              key={m.id}
              name={m.name}
              linked={m.linked}
              crown={m.id === data.creator_id}
              disabled={m.linked}
              onClick={() => requestSwitch({ member_id: m.id }, m.name)}
            />
          )
        )}
      </div>
      <div className="row">
        <input className="wide" value={newName} placeholder="Your name" onChange={(e) => setNewName(e.target.value)} />
        <button
          className="primary"
          disabled={!newName.trim()}
          onClick={async () => {
            requestSwitch({ name: newName.trim() }, newName.trim())
            setNewName("")
          }}
        >
          Join as new
        </button>
      </div>
      {!data.signed_in && (
        <div style={{ marginTop: 14 }}>
          <SignInButton
            label="Sign in to lock your name"
            onSignedIn={() => {
              reloadMe()
              void load()
            }}
          />
        </div>
      )}
      {onCancel && (
        <button className="link" style={{ marginTop: 8 }} onClick={onCancel}>
          cancel
        </button>
      )}
    </div>
  )
}
