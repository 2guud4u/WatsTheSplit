import React, { useState } from "react"
import { Awards } from "../components/Awards.tsx"
import { PickChip, SelfChip } from "../components/Chips.tsx"
import { FunNotice } from "../components/FunNotice.tsx"
import { DetailModal, JourneySettings, MarkPaidModal, TripsTab } from "../components/JourneyCards.tsx"
import { OweCard } from "../components/OweCard.tsx"
import { PageHead, Tabs } from "../components/PageHead.tsx"
import { GiftPrompt, markGiftSeen, Review, wantsGift } from "../components/Review.tsx"
import { ShareLink } from "../components/ShareLink.tsx"
import { SignInButton } from "../components/SignIn.tsx"
import { useJourney } from "../hooks/useJourney.ts"
import { useTabMemory } from "../hooks/useTabMemory.ts"
import type {
  JourneyView as JourneyData,
  JourneySettingsPatch,
  JourneyTrip as JTrip,
  Transfer,
} from "../services/api.ts"
import { BASE, describeError } from "../services/api.ts"
import { flag } from "../utils/format.ts"

export default function JourneyView({ token, reloadMe }: { token: string; reloadMe: () => void }) {
  const [addOpen, setAddOpen] = useState(false)
  const { data, err, load, actions } = useJourney(token)

  const [paying, setPaying] = useState<Transfer | null>(null)
  const [detail, setDetail] = useState<Transfer | null>(null)
  const [expandedTrips, setExpandedTrips] = useState<Set<string>>(new Set())
  const [showInvite, setShowInvite] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [pendingClaim, setPendingClaim] = useState<{
    t: JTrip
    input: { member_id: string } | { name: string }
    label: string
    curUsed: boolean
  } | null>(null)
  // in-app replacement for the native prompt() (which looks horrible on mobile):
  // the trip being named for + the draft name. Top-level state so the modal
  // input is stable across re-renders (no nested component).
  const [newNameFor, setNewNameFor] = useState<JTrip | null>(null)
  const [newNameDraft, setNewNameDraft] = useState("")

  // Trip Wrapped unlocks at trip end — or 5 days after creation when no end date is set.
  const wrappedLive = data
    ? !!(data.journey.fun_leaderboard && data.wrapped_at && Date.now() >= Date.parse(data.wrapped_at))
    : false
  const { tab, setTab } = useTabMemory<"trips" | "owed" | "youowe" | "people" | "fun">(
    token,
    ["trips", "owed", "youowe", "people", "fun"],
    "trips",
    wrappedLive
  )

  if (err) {
    if (err !== "no_access") return <p className="error">{err}</p>
    // Journey link open but no trip access yet: the join button records
    // the grant, then the page reloads with trips + claim chips.
    return (
      <>
        <h1>Shared journey</h1>
        <div className="card">
          <p className="muted">
            This journey link lets you view every trip in it and add yourself to the ones you joined.
          </p>
          <div className="row">
            <button
              className="primary"
              onClick={async () => {
                await actions.join()
              }}
            >
              Open journey
            </button>
            <SignInButton
              label="Already in a trip? Sign in"
              onSignedIn={() => {
                reloadMe()
                void load()
              }}
            />
          </div>
        </div>
      </>
    )
  }
  if (!data) return <p className="muted">Loading…</p>
  const j = data.journey
  const cur = j.settle_currency
  const link = `${location.origin}${BASE}/#/j/${j.token}`
  const myMembers = data.members.filter((m) => data.my_member_ids.includes(m.id))
  const allHidden = myMembers.length > 0 && myMembers.every((m) => m.opted_out_fun)

  const addTrip = async (tt: string) => {
    await actions.addTrip(tt)
    setAddOpen(false)
  }
  // Claim (or re-claim) a member in a trip. Switching away from a claimed
  // member confirms first — its expenses keep the old attribution.
  const requestClaim = (t: JTrip, input: { member_id: string } | { name: string }, label: string) => {
    const cur = t.members.find((mm) => data.my_member_ids.includes(mm.id))
    if (!cur)
      return void ("member_id" in input
        ? actions.claim(t.token, input.member_id)
        : actions.claimByName(t.token, input.name))
    setPendingClaim({ t, input, label, curUsed: cur.used })
  }
  const confirmClaim = async () => {
    const p = pendingClaim
    setPendingClaim(null)
    try {
      if (p && "member_id" in p.input) await actions.claim(p.t.token, p.input.member_id)
      else if (p && "name" in p.input) await actions.claimByName(p.t.token, p.input.name)
    } catch (e) {
      alert(describeError(e))
    }
  }
  const openNewName = (t: JTrip) => {
    setNewNameFor(t)
    setNewNameDraft("")
  }
  const confirmNewName = async () => {
    const name = newNameDraft.trim()
    if (!name || !newNameFor) return
    setNewNameFor(null)
    setNewNameDraft("")
    requestClaim(newNameFor, { name }, name)
  }

  // group members by merge key for the people panel
  const grouped = new Map<string, JourneyData["members"]>()
  for (const m of data.members) grouped.set(m.key, [...(grouped.get(m.key) ?? []), m])

  return (
    <>
      <PageHead title={j.name} back={{ href: "#/", label: "home" }} />
      <p className="muted" style={{ marginTop: 0 }}>
        Shared balance in {flag(cur)} {cur} · settle up inside trips
      </p>

      {/* my person chips: the merged members this session has claimed */}
      {(() => {
        const mine = data.persons.filter((p) => p.memberIds.some((id) => data.my_member_ids.includes(id)))
        return (
          <div className="row" style={{ marginBottom: 12 }}>
            {mine.map((p) => (
              <SelfChip key={p.key} name={p.name} linked={p.linked} />
            ))}
            {!data.signed_in && (
              <>
                <span className="muted">
                  {data.my_member_ids.length ? "not signed in — anyone can claim you" : "not signed in"}
                </span>
                <SignInButton
                  onSignedIn={() => {
                    reloadMe()
                    void load()
                  }}
                />
              </>
            )}
            <button className="link" onClick={() => setShowInvite(!showInvite)}>
              Invite
            </button>
            <button className="link" onClick={() => setShowSettings(!showSettings)}>
              Settings
            </button>
          </div>
        )
      })()}

      {showInvite && (
        <ShareLink url={link} note="Anyone with this link can view the trips and add themselves — keep it private." />
      )}

      {showSettings && (
        <JourneySettings
          data={data}
          patchSettings={actions.patchSettings}
          dissolve={actions.dissolve}
          savePayment={actions.savePayment}
          reloadMe={reloadMe}
          setShow={setShowSettings}
        />
      )}

      {wrappedLive && (
        <FunNotice
          storageKey={`wts_fun_notice_j${token}`}
          hidden={allHidden}
          onHide={() => actions.optOutFunAll(myMembers.map((m) => m.id))}
        >
          🎁 <b>Journey Wrapped</b> is on — silly awards computed across all {data.trips.length} trips in this journey.
        </FunNotice>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ["trips", "Trips"],
          ["owed", "Who owes you"],
          ["youowe", "Who you owe"],
          ["people", "People"],
          ...(wrappedLive ? [["fun", "Wrapped"] as const] : []),
        ]}
      />

      {tab === "fun" && (
        <Awards
          title="Journey Wrapped"
          awards={data.fun?.awards ?? null}
          review={data.fun?.review}
          currency={cur}
          onReplay={
            data.fun?.review
              ? () => {
                  markGiftSeen(`wts_reviewed_j${token}`)
                  setShowReview(true)
                }
              : undefined
          }
        />
      )}

      {wrappedLive && wantsGift(`wts_reviewed_j${token}`) && !showReview && (
        <GiftPrompt
          title="Journey Wrapped"
          onOpen={() => {
            markGiftSeen(`wts_reviewed_j${token}`)
            setShowReview(true)
          }}
        />
      )}
      {showReview && data.fun && (
        <Review
          title={`${j.name} Wrapped`}
          subtitle={`${data.trips.length} trip${data.trips.length === 1 ? "" : "s"} in this journey`}
          review={data.fun.review}
          awards={data.fun.awards}
          onClose={() => {
            setShowReview(false)
            setTab("fun")
          }}
        />
      )}

      {tab === "trips" && (
        <TripsTab
          data={data}
          cur={cur}
          actions={actions}
          requestClaim={requestClaim}
          openNewName={openNewName}
          expandedTrips={expandedTrips}
          setExpandedTrips={setExpandedTrips}
          addOpen={addOpen}
          setAddOpen={setAddOpen}
          addTrip={addTrip}
        />
      )}

      {(tab === "owed" || tab === "youowe") &&
        (() => {
          // viewer's person keys: persons containing any of my_member_ids
          const mine = new Set(data.members.filter((m) => data.my_member_ids.includes(m.id)).map((m) => m.key))
          const rows = data.transfers.filter((tr) =>
            mine.size === 0 ? tab === "owed" : tab === "owed" ? mine.has(tr.to_key) : mine.has(tr.from_key)
          )
          // The payee's Payment Method: a person's member (across its trips)
          // with the linked account's payment.
          const paymentFor = (key: string) => {
            const m = data.members.find((mm) => mm.key === key && mm.payment)
            return m?.payment ?? null
          }
          return (
            <div className="card">
              {mine.size === 0 && <p className="muted">You haven't joined a trip yet — showing everything.</p>}
              {rows.length === 0 && mine.size > 0 && (
                <p className="muted">{tab === "owed" ? "Nobody owes you." : "You owe nobody."}</p>
              )}
              {rows.length > 0 && (
                <div className="owe-grid">
                  {rows.map((tr) => (
                    <OweCard
                      key={tr.from_key + tr.to_key}
                      name={tab === "owed" ? tr.from : tr.to}
                      amount={tr.amount}
                      currency={cur}
                      dir={tab === "owed" ? "in" : "out"}
                      onConfirm={mine.size > 0 ? () => setPaying(tr) : undefined}
                      onDetails={tr.parts.some((p) => p.log.length > 0) ? () => setDetail(tr) : undefined}
                      payment={paymentFor(tab === "owed" ? tr.from_key : tr.to_key)}
                    />
                  ))}
                </div>
              )}
              {paying && (
                <MarkPaidModal
                  transfer={paying}
                  currency={cur}
                  trips={data.trips}
                  settlePart={actions.settlePart}
                  onClose={() => setPaying(null)}
                  onDone={() => {
                    setPaying(null)
                    void load()
                  }}
                />
              )}
              {detail && (
                <DetailModal transfer={detail} currency={cur} members={data.trips} onClose={() => setDetail(null)} />
              )}
            </div>
          )
        })()}

      {tab === "people" && (
        <>
          {data.mergeHints.length > 0 && (
            <div className="card">
              {data.mergeHints.map((h) => (
                <div key={h.name} className="expense-row">
                  <span>
                    <b>{h.name}</b> appears in {h.trips.join(" and ")} — same person?
                  </span>
                  <button className="link" onClick={() => actions.merge(h.member_ids)}>
                    merge
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="card">
            {[...grouped.entries()].map(([key, ms]) => {
              const person = data.persons.find((p) => p.key === key)
              const merged = ms.length > 1
              return (
                <div key={key} className="expense-row">
                  <span>
                    {person?.name ?? ms[0]?.name}
                    {merged && <span className="muted"> ({ms.map((m) => m.trip_name).join(" + ")})</span>}
                    {ms.some((m) => m.linked) && " ✓"}
                  </span>
                  {merged && ms.length > 1 && (
                    <span className="muted">
                      {ms.map((m) => (
                        <button
                          key={m.id}
                          className="link"
                          style={{ fontSize: 11 }}
                          onClick={() => actions.unmerge(m.id)}
                        >
                          unmerge {m.trip_name}
                        </button>
                      ))}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
      {pendingClaim && (
        <div className="modal-bg" onClick={() => setPendingClaim(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              Switch to {pendingClaim.label} in {pendingClaim.t.name}?
            </h3>
            {pendingClaim.curUsed && (
              <p className="warn">Expenses and payments recorded under your current name stay attributed to it.</p>
            )}
            <div className="modal-btns">
              <button onClick={() => setPendingClaim(null)}>cancel</button>
              <button className="primary" onClick={confirmClaim}>
                Switch
              </button>
            </div>
          </div>
        </div>
      )}
      {newNameFor && (
        <div className="modal-bg" onClick={() => setNewNameFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Join {newNameFor.name} as</h3>
            <div className="field">
              <label className="field-label">Your name</label>
              <input
                className="wide"
                autoFocus
                value={newNameDraft}
                placeholder="e.g. Dave"
                onChange={(e) => setNewNameDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirmNewName()}
              />
            </div>
            <div className="modal-btns">
              <button onClick={() => setNewNameFor(null)}>cancel</button>
              <button className="primary" disabled={!newNameDraft.trim()} onClick={confirmNewName}>
                Join
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
