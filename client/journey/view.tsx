import React, { useState } from "react";
import { BASE } from "../api.ts";
import type { JourneyView as JourneyData, JourneyTrip as JTrip, JourneySettingsPatch, Transfer } from "../api.ts";
import { fmtUnits, fmt, flag, decimals } from "../format.ts";
import { ShareLink } from "../ui/ShareLink.tsx";
import { OweCard } from "../ui/OweCard.tsx";
import { SignInButton } from "../ui/SignIn.tsx";
import { Awards } from "../ui/Awards.tsx";
import { FunNotice } from "../ui/FunNotice.tsx";
import { PickChip, SelfChip } from "../ui/Chips.tsx";
import { PageHead, Tabs } from "../ui/PageHead.tsx";
import { Review, GiftPrompt, wantsGift, markGiftSeen } from "../ui/Review.tsx";
import { useJourney } from "./model.ts";

export default function JourneyView({ token, reloadMe }: { token: string; reloadMe: () => void }) {
  const { data, err, load, actions } = useJourney(token);
  const [addOpen, setAddOpen] = useState(false);
  const [tab, setTab] = useState<"trips" | "owed" | "youowe" | "people" | "fun">("trips");
  const [paying, setPaying] = useState<Transfer | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showReview, setShowReview] = useState(false);

  if (err) {
    if (err !== "no_access") return <p className="error">{err}</p>;
    // Journey link open but no trip access yet: the join button records
    // the grant, then the page reloads with trips + claim chips.
    return (
      <>
        <h1>Shared journey</h1>
        <div className="card">
          <p className="muted">This journey link lets you view every trip in it and add yourself to the ones you joined.</p>
          <div className="row">
            <button className="primary" onClick={async () => {
              await actions.join();
            }}>Open journey</button>
            <SignInButton label="Already in a trip? Sign in" onSignedIn={() => { reloadMe(); load(); }} />
          </div>
        </div>
      </>
    );
  }
  if (!data) return <p className="muted">Loading…</p>;
  const j = data.journey;
  const cur = j.settle_currency;
  const link = `${location.origin}${BASE}/#/j/${j.token}`;
  const wrappedLive = !!(j.fun_leaderboard && data.wrapped_at && Date.now() >= Date.parse(data.wrapped_at));
  const myMembers = data.members.filter((m) => data.my_member_ids.includes(m.id));
  const allHidden = myMembers.length > 0 && myMembers.every((m) => m.opted_out_fun);

  const addTrip = async (tt: string) => {
    await actions.addTrip(tt); setAddOpen(false);
  };
  const claimIn = (tripToken: string, memberId: string) => actions.claim(tripToken, memberId);

  // group members by merge key for the people panel
  const grouped = new Map<string, JourneyData["members"]>();
  for (const m of data.members) grouped.set(m.key, [...(grouped.get(m.key) ?? []), m]);

  return (
    <>
      <PageHead title={j.name} back={{ href: "#/", label: "home" }} />
      <p className="muted" style={{ marginTop: 0 }}>
        Shared balance in {flag(cur)} {cur} · settle up inside trips
      </p>

      {/* my person chips: the merged members this session has claimed */}
      {(() => {
        const mine = data.persons.filter((p) => p.memberIds.some((id) => data.my_member_ids.includes(id)));
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
                <SignInButton onSignedIn={() => { reloadMe(); load(); }} />
              </>
            )}
            <button className="link" onClick={() => setShowInvite(!showInvite)}>Invite</button>
            <button className="link" onClick={() => setShowSettings(!showSettings)}>Settings</button>
          </div>
        );
      })()}

      {showInvite && <ShareLink url={link} note="Anyone with this link can view the trips and add themselves — keep it private." />}

      {showSettings && <JourneySettings data={data} patchSettings={actions.patchSettings} dissolve={actions.dissolve} setShow={setShowSettings} />}

      {wrappedLive && (
        <FunNotice storageKey={`wts_fun_notice_j${token}`}
          hidden={allHidden}
          onHide={() => actions.optOutFunAll(myMembers.map((m) => m.id))}>
          🎁 <b>Journey Wrapped</b> is on — silly awards computed across all {data.trips.length} trips in this journey.
        </FunNotice>
      )}

      <Tabs value={tab} onChange={setTab} tabs={[
        ["trips", "Trips"],
        ["owed", "Who owes you"],
        ["youowe", "Who you owe"],
        ["people", "People"],
        ...(wrappedLive ? [["fun", "🎁 Journey Wrapped"] as const] : []),
      ]} />

      {tab === "fun" && <Awards title="Journey Wrapped" awards={data.fun?.awards ?? null}
        review={data.fun?.review} currency={cur}
        onReplay={data.fun?.review ? () => { markGiftSeen(`wts_reviewed_j${token}`); setShowReview(true); } : undefined} />}

      {wrappedLive && wantsGift(`wts_reviewed_j${token}`) && !showReview && (
        <GiftPrompt title="Journey Wrapped"
          onOpen={() => { markGiftSeen(`wts_reviewed_j${token}`); setShowReview(true); }} />
      )}
      {showReview && data.fun && (
        <Review title={`${j.name} Wrapped`} subtitle={`${data.trips.length} trip${data.trips.length === 1 ? "" : "s"} in this journey`}
          review={data.fun.review} awards={data.fun.awards}
          onClose={() => { setShowReview(false); setTab("fun"); }} />
      )}

      {tab === "trips" && (
        <>
          {data.trips.map((t) => (
            <div key={t.token} className="card" style={{ marginBottom: 10 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}><a href={`#/t/${t.token}`}>{t.name}</a></h2>
                <span className="muted">{t.access === "view" ? "view only" : flag(t.settle_currency ?? "") + " " + t.settle_currency}</span>
              </div>
              {t.access === "view" && (
                <div className="row" style={{ flexWrap: "wrap", margin: "8px 0" }}>
                  {t.members.map((mm) => (
                    <PickChip key={mm.id} name={mm.name} linked={mm.linked}
                      disabled={mm.linked && !data.signed_in}
                      onClick={() => claimIn(t.token, mm.id)} />
                  ))}
                  <button className="link" onClick={async () => {
                    const name = prompt("Your name for this trip:");
                    if (!name?.trim()) return;
                    try { await actions.claimByName(t.token, name.trim()); }
                    catch { alert("Name taken — pick another."); }
                  }}>+ new name</button>
                </div>
              )}
              {t.expenses.length === 0 && <p className="muted">No expenses yet.</p>}
              {t.expenses.map((e) => (
                <div key={e.id} className="expense-row">
                  <a href={`#/t/${t.token}/e/${e.id}`}>{e.name}</a>
                  <span>
                    {fmt(e.total_minor, e.currency)}
                    {e.unassigned_minor > 0 && !e.over &&
                      <span className="badge badge-unassigned"> {fmt(e.unassigned_minor, e.currency)} unassigned</span>}
                  </span>
                </div>
              ))}
              {t.access === "edit" && (
                <button className="link" onClick={() => actions.removeTrip(t.token)}>remove from journey</button>
              )}
            </div>
          ))}
          <button className="link" onClick={() => setAddOpen(!addOpen)}>+ Add a trip</button>
          {addOpen && (
            <div className="card" style={{ marginTop: 8 }}>
              {data.mergeableTrips.length === 0 && <p className="muted">No other trips available.</p>}
              {data.mergeableTrips.map((t) => {
                const ok = t.settle_currency === cur;
                return (
                  <div key={t.token} className="expense-row">
                    <span className={ok ? "" : "muted"}>{t.name}</span>
                    {ok
                      ? <button className="link" onClick={() => addTrip(t.token)}>add</button>
                      : <span className="muted">settles in {t.settle_currency} — journey is {cur}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {(tab === "owed" || tab === "youowe") && (() => {
        // viewer's person keys: persons containing any of my_member_ids
        const mine = new Set(data.members.filter((m) => data.my_member_ids.includes(m.id)).map((m) => m.key));
        const rows = data.transfers.filter((tr) =>
          mine.size === 0 ? tab === "owed" : tab === "owed" ? mine.has(tr.to_key) : mine.has(tr.from_key));
        return (
          <div className="card">
            {mine.size === 0 && <p className="muted">You haven't joined a trip yet — showing everything.</p>}
            {rows.length === 0 && mine.size > 0 && (
              <p className="muted">{tab === "owed" ? "Nobody owes you." : "You owe nobody."}</p>
            )}
            {rows.length > 0 && (
              <div className="owe-grid">
                {rows.map((tr) => (
                  <OweCard key={tr.from_key + tr.to_key}
                    name={tab === "owed" ? tr.from : tr.to}
                    amount={tr.amount} currency={cur}
                    dir={tab === "owed" ? "in" : "out"}
                    onConfirm={mine.size > 0 ? () => setPaying(tr) : undefined} />
                ))}
              </div>
            )}
            {paying && (
              <MarkPaidModal transfer={paying} currency={cur} trips={data.trips}
                settlePart={actions.settlePart}
                onClose={() => setPaying(null)} onDone={() => { setPaying(null); load(); }} />
            )}
          </div>
        );
      })()}

      {tab === "people" && (
        <>
          {data.mergeHints.length > 0 && (
            <div className="card">
              {data.mergeHints.map((h) => (
                <div key={h.name} className="expense-row">
                  <span><b>{h.name}</b> appears in {h.trips.join(" and ")} — same person?</span>
                  <button className="link" onClick={() => actions.merge(h.member_ids)}>merge</button>
                </div>
              ))}
            </div>
          )}
          <div className="card">
            {[...grouped.entries()].map(([key, ms]) => {
              const person = data.persons.find((p) => p.key === key);
              const merged = ms.length > 1;
              return (
                <div key={key} className="expense-row">
                  <span>
                    {person?.name ?? ms[0].name}
                    {merged && <span className="muted"> ({ms.map((m) => m.trip_name).join(" + ")})</span>}
                    {ms.some((m) => m.linked) && " ✓"}
                  </span>
                  {merged && ms.length > 1 && (
                    <span className="muted">
                      {ms.map((m) => (
                        <button key={m.id} className="link" style={{ fontSize: 11 }}
                          onClick={() => actions.unmerge(m.id)}>unmerge {m.trip_name}</button>
                      ))}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

// Settle a journey card: tick any trips, then record one Settlement per ticked
// trip for that trip's full debt, in that trip's own direction, between its own
// Members. Real money only moves once, for the net of the ticked trips; recording
// each trip in full is what makes every ticked trip balance exactly zero.
function MarkPaidModal({ transfer, currency, trips, settlePart, onClose, onDone }: {
  transfer: Transfer; currency: string; trips: JTrip[];
  settlePart: (p: Transfer["parts"][number], minor: number) => Promise<unknown>;
  onClose: () => void; onDone: () => void;
}) {
  const { from, to, parts } = transfer; // card direction: `from` owes `to` overall
  const [picked, setPicked] = useState<Set<string>>(() => new Set(parts.map((p) => p.trip_token)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = parts.filter((p) => picked.has(p.trip_token));
  const all = chosen.length === parts.length;
  // net in the card's direction; negative means the ticked trips lean the other way
  const net = chosen.reduce((s, p) => s + (p.against ? -p.amount : p.amount), 0);
  const half = 0.5 / 10 ** decimals(currency);
  const label = Math.abs(net) < half ? "even, no money changes hands"
    : net > 0 ? `${from} pays ${to} ${fmtUnits(net, currency)}`
    : `${to} pays ${from} ${fmtUnits(-net, currency)}`;
  const canEdit = (tt: string) => trips.find((t) => t.token === tt)?.access === "edit";
  const blocked = chosen.filter((p) => !canEdit(p.trip_token));
  const toggle = (tt: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(tt); else next.delete(tt);
    setPicked(next);
  };

  const submit = async () => {
    setBusy(true); setError("");
    try {
      for (const p of chosen) {
        const minor = Math.round(p.amount * 10 ** decimals(currency));
        if (minor <= 0) continue;
        await settlePart(p, minor);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settle {from} ↔ {to}</h3>
        <label className="expense-row">
          <span><input type="checkbox" checked={all}
            onChange={(e) => setPicked(new Set(e.target.checked ? parts.map((p) => p.trip_token) : []))} /> All trips</span>
          <b>{from} owes {to} {fmtUnits(transfer.amount, currency)}</b>
        </label>
        {parts.map((p) => (
          <label key={p.trip_token} className="expense-row" style={{ paddingLeft: 22 }}>
            <span><input type="checkbox" checked={picked.has(p.trip_token)}
              onChange={(e) => toggle(p.trip_token, e.target.checked)} /> {p.trip_name}</span>
            <span className={p.against ? "muted" : ""}>
              {p.against ? `${to} owes ${from}` : `${from} owes ${to}`} {fmtUnits(p.amount, currency)}
            </span>
          </label>
        ))}
        {chosen.some((p) => p.against) && chosen.some((p) => !p.against) && (
          <p className="muted">Each ticked trip is recorded in full so it ends at zero; in real life only the net changes hands.</p>
        )}
        {blocked.length > 0 && (
          <p className="warn">Pick your name in {blocked.map((p) => p.trip_name).join(", ")} first — you can only record payments in trips you've joined.</p>
        )}
        {error && <div className="error">{error}</div>}
        <div className="modal-btns">
          <button className="link" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || chosen.length === 0 || blocked.length > 0} onClick={submit}>
            Record: {label}
          </button>
        </div>
      </div>
    </div>
  );
}

// Journey settings: rename, read-only shared currency (inherited from the
// trips), and dissolve. Removing trips / merging people lives on the tabs.
function JourneySettings({ data, patchSettings, dissolve, setShow }: {
  data: JourneyData;
  patchSettings: (p: JourneySettingsPatch) => Promise<void>;
  dissolve: (name: string) => Promise<unknown>;
  setShow: (b: boolean) => void;
}) {
  const j = data.journey;
  const [delName, setDelName] = useState("");
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <div className="field">
        <label className="field-label">Name</label>
        <input className="wide" defaultValue={j.name} onBlur={async (e) => {
          if (e.target.value.trim() && e.target.value !== j.name) {
            await patchSettings({ name: e.target.value.trim() });
          }
        }} />
      </div>
      <div className="field">
        <label className="field-label">Settlement currency</label>
        <div className="locked-field">{flag(j.settle_currency)} {j.settle_currency}</div>
        <p className="muted">Shared by every trip in the journey</p>
      </div>
      <div className="field">
        <label className="field-label">🎁 Journey Wrapped</label>
        <label className="member-chip" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={j.fun_leaderboard} onChange={async (e) => {
            await patchSettings({ fun_leaderboard: e.target.checked });
          }} />
          Show the Journey Wrapped tab with silly awards
        </label>
        <p className="muted">Awards unlock after the last trip ends.</p>
      </div>
      <div className="field">
        <label className="field-label error">Danger zone</label>
        <div className="row">
          <input value={delName} placeholder={`Type "${j.name}" to dissolve`}
            onChange={(e) => setDelName(e.target.value)} />
          <button className="danger" disabled={delName !== j.name} onClick={async () => {
            await dissolve(delName);
            location.hash = "#/";
          }}>Dissolve journey</button>
        </div>
        <p className="muted">Dissolving ungroups the trips — they keep their own data.</p>
      </div>
      <button onClick={() => setShow(false)}>Close</button>
    </div>
  );
}
