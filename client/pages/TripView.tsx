import React, { useState, useEffect } from "react";
import { BASE, describeError, type Config } from "../services/api.ts";
import type { TripView as TripData, TripSettingsPatch, ClaimInput } from "../services/api.ts";
import { toMinor, fmt, fmtUnits, decimals, flag, CATEGORIES } from "../utils/format.ts";
import { showSnack } from "../components/Snack.tsx";
import { CurrencyPicker } from "../components/CurrencyPicker.tsx";
import { OweCard, memberName } from "../components/OweCard.tsx";
import { OweDetailsModal } from "../components/OweDetailsModal.tsx";
import { SignInButton } from "../components/SignIn.tsx";
import { RangePicker } from "../components/RangePicker.tsx";
import type { DateRange } from "react-day-picker";
import { ShareLink } from "../components/ShareLink.tsx";
import { Awards } from "../components/Awards.tsx";
import { FunNotice } from "../components/FunNotice.tsx";
import { PickChip, SelfChip } from "../components/Chips.tsx";
import { PageHead, Tabs } from "../components/PageHead.tsx";
import { Review, GiftPrompt, wantsGift, markGiftSeen } from "../components/Review.tsx";
import { useTrip } from "../hooks/useTrip.ts";
import { useTabMemory } from "../hooks/useTabMemory.ts";
import { useTripHistory } from "../hooks/useTripHistory.ts";
import { historyValueLabel, historyEntrySentence } from "../utils/format.ts";
import { PaymentForm, PaymentPromptModal, paymentPromptSeen, markPaymentPromptSeen, paymentHasInfo } from "../components/PaymentForm.tsx";
import { ClaimCard } from "../components/ClaimCard.tsx";
import { SettleCard } from "../components/SettleCard.tsx";
import { Settings } from "../components/Settings.tsx";

// One owe-card with its own details modal. Defined at module level (NOT inside
// TripView's render) so React keeps the same component instance across
// re-renders: opening details fires a mutation, which echoes back into
// `load()` → re-render, and a component defined inline inside the render
// would have its `mathOpen` state reset to false, closing the modal.
function Owe({ p, dir, data, readOnly, markPaid, onDetail }: {
  p: { from: string; to: string; amount: number }; dir: "in" | "out";
  data: TripData; readOnly: boolean;
  markPaid: (p: { from: string; to: string; amount: number }) => Promise<void>;
  onDetail: () => void;
}) {
  const other = dir === "in" ? p.from : p.to;
  const m = data.members.find((mm) => mm.id === other);
  const fwd = data.balance_log?.[`${p.from}>${p.to}`] ?? [];
  const [mathOpen, setMathOpen] = useState(false);
  const [showRate, setShowRate] = useState(false);
  const rev = data.balance_log?.[`${p.to}>${p.from}`] ?? [];
  const entries = [
    ...fwd.map((en) => ({ ...en, sign: 1 })),
    ...rev.map((en) => ({ ...en, sign: -1 })),
  ];
  return (
    <>
      <OweCard name={m?.name ?? "?"} amount={p.amount} currency={data.trip.settle_currency} dir={dir}
        onConfirm={readOnly ? undefined : async () => { await markPaid(p); }}
        onDetails={entries.length ? () => {
          setMathOpen(true);
          onDetail();
        } : undefined}
        payment={m?.payment} />
      {mathOpen && (
        <OweDetailsModal
          title={`${m?.name ?? "?"} · ${fmtUnits(p.amount, data.trip.settle_currency)}`}
          currency={data.trip.settle_currency}
          entries={entries}
          labelFor={(en) => en.kind === "settlement"
            ? `${memberName(data.members, en.sign > 0 ? p.from : p.to)} paid ${memberName(data.members, en.sign > 0 ? p.to : p.from)}`
            : en.label}
          showRate={showRate}
          onShowRate={() => setShowRate(!showRate)}
          footer={<div className="math-row math-total">
            <span>= net</span>
            <span className="amt">{fmtUnits(p.amount, data.trip.settle_currency)}</span>
          </div>}
          onClose={() => { setMathOpen(false); setShowRate(false); }} />
      )}
    </>
  );
}

export default function TripView({ token, config, reloadMe }: {
  token: string; config: Config | null;
  reloadMe: () => void;
}) {
  const vm = useTrip(token);
  const { data, needsPassword, load, actions } = vm;
  const [password, setPassword] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [expName, setExpName] = useState("");
  const [expTotal, setExpTotal] = useState("");
  const [expCur, setExpCur] = useState<string | null>(null);

  const [expPayer, setExpPayer] = useState("");
  const [settle, setSettle] = useState({ from: "", to: "", amount: "" });
  const [showSettings, setShowSettings] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{ input: ClaimInput; label: string } | null>(null);
  const [showReview, setShowReview] = useState(false);
  // Post-create category prompt: when Wrapped is enabled (the fun_leaderboard
  // setting), ask for a category after an expense is created. The expense is
  // already saved; the prompt only sets its category. Skip (button or backdrop)
  // leaves it uncategorized.
  const [categoryPrompt, setCategoryPrompt] = useState<string | null>(null);

  // Trip Wrapped unlocks at trip end — or 5 days after creation when no end date is set.
  const wrappedAt = data ? (data.trip.end_date ? `${data.trip.end_date}T23:59:59` : new Date(new Date(data.trip.created_at).getTime() + 5 * 86400e3).toISOString()) : "";
  const wrappedLive = data ? (data.trip.fun_leaderboard && Date.now() >= Date.parse(wrappedAt)) : false;
  const { tab, setTab } = useTabMemory<"expenses" | "owed" | "youowe" | "fun" | "history">(token, ["expenses", "owed", "youowe", "fun", "history"], "owed", wrappedLive);
  const { history } = useTripHistory(token);

  // "How to pay you?" prompt: once per user (global flag), for anyone who
  // joined (have a claim) or the trip has ended, when their Payment Method
  // is empty. No sign-in gate — friction-free. Must run before the early
  // returns so hook order stays stable.
  const [showPaymentPrompt, setShowPaymentPrompt] = useState(false);
  useEffect(() => {
    if (!data || !data.me) return;
    if (paymentHasInfo(data.me.payment)) return;
    if (paymentPromptSeen()) return;
    setShowPaymentPrompt(true);
  }, [data]);

  if (needsPassword) {
    return (
      <>
        <h1>Locked trip</h1>
        <div className="card">
          <p className="muted">This trip needs its password.</p>
          <div className="row">
            <input type="password" value={password} placeholder="Trip password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && document.getElementById("pwgo")?.click()} />
            <button id="pwgo" className="primary" onClick={async () => {
              if (await actions.unlock(password) === "bad") setPwErr("Wrong password");
            }}>Open</button>
          </div>
          {pwErr && <div className="error">{pwErr}</div>}
        </div>
      </>
    );
  }

  if (!data) return <p className="muted">Loading…</p>;
  const t = data.trip;
  const currencies = config?.currencies ?? [];

  const me = data.me;
  const readOnly = data.access === "view";
  const markPaid = async (p: { from: string; to: string; amount: number }) => {
    await actions.settle({
      from_member: p.from, to_member: p.to,
      amount_minor: Math.round(p.amount * 10 ** decimals(t.settle_currency)),
    });
  };

  // ---------- who are you ----------
  // Journey viewers (readOnly) get the claim card on top and the trip below;
  // everyone else must pick a name before seeing content. The same card
  // doubles as the "switch who I am" picker once a member is claimed.
  const meMember = me ? data.members.find((m) => m.id === me.id) : null;
  const draftActive = !!(expName.trim() || expTotal || settle.from || settle.to || settle.amount);
  const requestSwitch = (input: ClaimInput, label: string) =>
    me ? setPendingSwitch({ input, label }) : void actions.claim(input);
  const switchModal = pendingSwitch && me && (
    <div className="modal-bg" onClick={() => setPendingSwitch(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Switch from {me.name} to {pendingSwitch.label}?</h3>
        {meMember?.used && (
          <p className="warn">Expenses and payments recorded under {me.name} stay attributed to {me.name}.</p>
        )}
        {draftActive && <p className="warn">Anything typed but not saved will be discarded.</p>}
        <div className="modal-btns">
          <button onClick={() => setPendingSwitch(null)}>cancel</button>
          <button className="primary" onClick={async () => {
            const p = pendingSwitch;
            setPendingSwitch(null);
            await actions.claim(p.input);
            setSwitching(false);
            setExpName(""); setExpTotal(""); setExpPayer("");
            setSettle({ from: "", to: "", amount: "" });
          }}>Switch</button>
        </div>
      </div>
    </div>
  );

  const claimProps = {
    data, readOnly, requestSwitch, load, reloadMe,
  };

  if (!me && !readOnly) {
    return (
      <>
        <h1>{t.name}</h1>
        <ClaimCard {...claimProps} />
      </>
    );
  }

  if (switching && me) {
    return (
      <>
        <h1>{t.name}</h1>
        <ClaimCard {...claimProps} switching onCancel={() => setSwitching(false)} />
        {switchModal}
      </>
    );
  }

  const inviteUrl = `${location.origin}${BASE}/#/t/${token}${t.password ? `?pw=${encodeURIComponent(t.password)}` : ""}`;

  const createExpense = async () => {
    const name = expName.trim();
    if (!name || !expTotal) return;
    const cur = expCur ?? t.trip_currency;
    const r = await actions.createExpense({
      name, total_minor: toMinor(expTotal, cur),
      currency: cur,
      payer_member_id: expPayer || me?.id,
    });
    showSnack(`Added ${name} · ${fmt(toMinor(expTotal, cur), cur)}`);
    setExpName(""); setExpTotal("");
    if (t.fun_leaderboard) {
      // Keep the trip page mounted until the prompt is answered — the prompt
      // must not render on the page we'd otherwise navigate to.
      setCategoryPrompt(r.id);
    } else {
      location.hash = `#/t/${token}/e/${r.id}`;
    }
  };

  return (
    <>
      <PageHead title={t.name} back={{ href: "#/", label: "home" }} />
      <p className="muted" style={{ marginTop: 0 }}>
        {data.current_rate && t.trip_currency !== t.settle_currency
          ? `1 ${t.trip_currency} ≈ ${data.current_rate.rate.toPrecision(6)} ${t.settle_currency} · 1 ${t.settle_currency} ≈ ${(1 / data.current_rate.rate).toPrecision(6)} ${t.trip_currency}`
          : t.trip_currency === t.settle_currency ? "same currency — no conversion" : "no exchange rate yet"}
      </p>
      <p className="muted">
        {t.start_date && t.end_date ? `${t.start_date} → ${t.end_date} · ` : ""}
        {t.trip_currency} trip · settles in {t.settle_currency}
        {data.fx_timestamp && ` · rates as of ${new Date(data.fx_timestamp).toLocaleString()}`}
        {t.has_password && " · 🔒"}
        {data.journey && <> · part of <a href={`#/j/${data.journey.token}`}>{data.journey.name}</a></>}
      </p>

      {readOnly && !me && <ClaimCard {...claimProps} />}
      <div className="row" style={{ marginBottom: 12 }}>
        {me && <SelfChip name={me.name} linked={me.linked} crown={me.id === data.creator_id} />}
        {me && (
          <button className="link" onClick={() => setSwitching(true)}>Not {me.name}?</button>
        )}
        {me && !me.linked && (
          <>
            <span className="muted">not signed in — anyone can claim you</span>
            <SignInButton onSignedIn={() => { reloadMe(); load(); }} />
          </>
        )}
        {!readOnly && <button className="link" onClick={() => setShowInvite(!showInvite)}>Invite</button>}
        {!readOnly && <button className="link" onClick={() => setShowSettings(!showSettings)}>Settings</button>}
      </div>

      {showInvite && <ShareLink url={inviteUrl} note="Anyone with this link can join — keep it private." />}

      {showSettings && <Settings data={data} token={token} currencies={currencies} actions={actions}
        onSwitch={(id, name) => requestSwitch({ member_id: id }, name)} setShow={setShowSettings}
        reloadMe={reloadMe} />}
      {switchModal}
      {showPaymentPrompt && data.me && (
        <PaymentPromptModal
          initial={data.me.payment}
          onClose={() => { setShowPaymentPrompt(false); markPaymentPromptSeen(); }}
          onSaved={() => { setShowPaymentPrompt(false); markPaymentPromptSeen(); reloadMe(); }}
          onSave={(p) => actions.savePayment(p)} />
      )}
      {categoryPrompt && (
        <div className="modal-bg" onClick={() => { setCategoryPrompt(null); location.hash = `#/t/${token}/e/${categoryPrompt}`; }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>What category is this?</h3>
            <p className="muted">
              Wrapped is on for this trip — categories power its silly awards.
              You can skip and change it later on the expense.
            </p>
            <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {Object.entries(CATEGORIES).map(([cat, emoji]) => (
                <button key={cat} className="member-chip" onClick={async () => {
                  const id = categoryPrompt;
                  setCategoryPrompt(null);
                  await actions.patchExpense(id, { category: cat });
                  location.hash = `#/t/${token}/e/${id}`;
                }}>{emoji} {cat}</button>
              ))}
            </div>
            <div className="modal-btns">
              <button className="link" onClick={() => { setCategoryPrompt(null); location.hash = `#/t/${token}/e/${categoryPrompt}`; }}>
                skip for now
              </button>
            </div>
          </div>
        </div>
      )}
      {wrappedLive && (
        <FunNotice storageKey={`wts_fun_notice_${token}`}
          hidden={me?.opted_out_fun}
          onHide={() => actions.optOutFun(me!.id)}>
          🎁 <b>Trip Wrapped</b> is on — the trip creator enabled silly awards from this trip's expense data (who pays, owes, drinks, eats).
        </FunNotice>
      )}

      <Tabs value={tab} onChange={setTab} tabs={[
        ["expenses", "Expenses"],
        ["owed", "Who owes you"],
        ["youowe", "Who you owe"],
        ...(wrappedLive ? [["fun", "Wrapped"] as const] : []),
        ["history", "History"],
      ]} />
      {(tab === "owed" || tab === "youowe") && (() => {
        const oweYou = data.balances.filter((p) => p.to === me?.id);
        const youOwe = data.balances.filter((p) => p.from === me?.id);
        const others = data.balances.filter((p) => p.from !== me?.id && p.to !== me?.id);
        return (
        <div className="card">
          {data.no_rate_count > 0 && (
            <p className="warn" style={{ marginTop: 0 }}>
              {data.no_rate_count} expense{data.no_rate_count > 1 ? "s" : ""} ha{data.no_rate_count > 1 ? "ve" : "s"} no exchange rate and {data.no_rate_count > 1 ? "are" : "is"} not counted in these balances.
            </p>
          )}
          {data.unfinished_count > 0 && (
            <p className="warn" style={{ marginTop: 0 }}>
              {data.unfinished_count} expense{data.unfinished_count > 1 ? "s are" : " is"} not fully split — open {data.unfinished_count > 1 ? "them" : "it"} before settling.
            </p>
          )}
          {!me && <p className="muted">You haven't picked your name yet — showing everyone's balances.</p>}
          {tab === "owed" && me && (
            oweYou.length === 0
              ? <p className="muted">Nobody owes you.</p>
              : <div className="owe-grid">
                  {oweYou.map((p) => <Owe key={p.from} p={p} dir="in" data={data} readOnly={readOnly} markPaid={markPaid} onDetail={actions.detailView} />)}
                </div>
          )}

          {tab === "youowe" && me && (
            youOwe.length === 0
              ? <p className="muted">You owe nobody.</p>
              : <div className="owe-grid">
                  {youOwe.map((p) => <Owe key={p.to} p={p} dir="out" data={data} readOnly={readOnly} markPaid={markPaid} onDetail={actions.detailView} />)}
                </div>
          )}

          {(tab === "owed" || !me) && others.length > 0 && (
            me ? (
            <details className="more">
              <summary>Other pairs</summary>
              {others.map((p) => (
                <div key={p.from + p.to} className="expense-row muted">
                  <span>{memberName(data.members, p.from)} owes {memberName(data.members, p.to)}</span>
                  <span>{fmtUnits(p.amount, t.settle_currency)}</span>
                </div>
              ))}
            </details>
            ) : (
              <div className="owe-grid">
                {others.map((p) => (
                  <div key={p.from + p.to} className="expense-row">
                    <span>{memberName(data.members, p.from)} owes {memberName(data.members, p.to)}</span>
                    <b>{fmtUnits(p.amount, t.settle_currency)}</b>
                  </div>
                ))}
              </div>
            )
          )}

          {data.settlements.length > 0 && (
            <>
              <h2 style={{ marginTop: 16 }}>Recorded payments</h2>
              {data.settlements.map((s) => (
                <div key={s.id} className="expense-row muted">
                  <span>{memberName(data.members, s.from_member)} paid {memberName(data.members, s.to_member)}</span>
                  <span>{fmt(s.amount_minor, t.settle_currency)}
                    {!readOnly && <button className="link danger" onClick={async () => {
                      await actions.deleteSettlement(s.id);
                    }}>✕</button>}
                  </span>
                </div>
              ))}
            </>
          )}

          {tab === "youowe" && !readOnly && (
          <SettleCard data={data} settle={settle} setSettle={setSettle}
            record={async (p) => {
              await actions.settle({
                from_member: p.from, to_member: p.to,
                amount_minor: toMinor(p.amount, t.settle_currency),
              });
            }} />
          )}
        </div>
        );
      })()}

      {tab === "fun" && <Awards title="Trip Wrapped" awards={data.fun?.awards ?? null}
        review={data.fun?.review} currency={t.settle_currency}
        onReplay={data.fun?.review ? () => { markGiftSeen(`wts_reviewed_${token}`); setShowReview(true); } : undefined} />}

      {tab === "history" && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Every change, newest first</h2>
          {history.length === 0 && <p className="muted">No changes recorded yet.</p>}
          {history.length > 0 && history.map((h) => (
            <div key={h.id} className="expense-row" style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span>{historyEntrySentence(h)}</span>
              </div>
              <span className="muted" style={{ whiteSpace: "nowrap" }}>
                {new Date(h.created_at).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      )}

      {wrappedLive && wantsGift(`wts_reviewed_${token}`) && !showReview && (
        <GiftPrompt title="Trip Wrapped"
          onOpen={() => { markGiftSeen(`wts_reviewed_${token}`); setShowReview(true); }} />
      )}
      {showReview && data.fun && (
        <Review title={`${t.name} Wrapped`} subtitle={`${t.trip_currency} trip · ${data.expenses.length} expenses`}
          review={data.fun.review} awards={data.fun.awards}
          onClose={() => { setShowReview(false); setTab("fun"); }} />
      )}

      {tab === "expenses" && (
      <>

      <h2>Expenses</h2>
      {data.unfinished_count > 0 && (
        <p className="warn">{data.unfinished_count} expense{data.unfinished_count > 1 ? "s are" : " is"} not fully split yet.</p>
      )}
      <div className="card">
        <div className="row">
          <input className="wide" value={expName} placeholder="Expense name"
            onChange={(e) => setExpName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createExpense()} />
          <input className="money" value={expTotal} placeholder="Total" inputMode="decimal"
            onChange={(e) => setExpTotal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createExpense()} />
          <button className="primary" onClick={createExpense} disabled={readOnly || !expName.trim() || !expTotal}>Add</button>
        </div>
        <details className="more">
          <summary>Payer &amp; currency</summary>
          <div className="row">
            <div className="field"><label className="field-label">Currency</label>
              <CurrencyPicker value={expCur ?? t.trip_currency} options={currencies} onChange={setExpCur} /></div>
            <div className="field"><label className="field-label">Paid by</label>
              <select value={expPayer || me?.id} onChange={(e) => setExpPayer(e.target.value)}>
                <option value={me?.id}>{me?.name} (you)</option>
                {data.members.filter((m) => m.id !== me?.id).map((m) =>
                  <option key={m.id} value={m.id}>{m.name}</option>)}
              </select></div>
          </div>
        </details>
        {data.expenses.map((e) => (
          <div key={e.id} className="expense-row">
            <a href={`#/t/${token}/e/${e.id}`}>{e.category ? `${CATEGORIES[e.category] ?? ""} ` : ""}{e.name}</a>
            <span>
              {fmt(e.total_minor, e.currency)}{" "}
              {e.unassigned_minor === 0
                ? <span className="badge badge-done">✓ assigned</span>
                : e.over
                ? <span className="badge badge-unassigned">over by {fmt(-e.unassigned_minor, e.currency)}</span>
                : <span className="badge badge-unassigned">{fmt(e.unassigned_minor, e.currency)} unassigned</span>}
              {e.rate === null && e.currency !== t.settle_currency &&
                <span className="badge badge-unassigned" title="Not counted in balances">no rate</span>}
              {e.paid_out
                ? <span className="badge badge-done">✓ paid</span>
                : (e.paid_count ?? 0) > 0 && <span className="badge badge-done">{e.paid_count}/{e.share_count} paid</span>}
            </span>
          </div>
        ))}
        {data.expenses.length === 0 && <p className="muted">No expenses yet.</p>}
      </div>
      </>
      )}
    </>
  );
}
