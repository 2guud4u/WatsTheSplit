import React, { useState } from "react";
import { BASE, Config, Me } from "../api.ts";
import type { TripView as TripData, TripSettingsPatch } from "../api.ts";
import { toMinor, fmt, fmtUnits, decimals, flag, CATEGORIES } from "../format.ts";
import { CurrencyPicker } from "../ui/CurrencyPicker.tsx";
import { OweCard, memberName } from "../ui/OweCard.tsx";
import { SignInButton } from "../ui/SignIn.tsx";
import { RangePicker } from "../ui/RangePicker.tsx";
import type { DateRange } from "react-day-picker";
import { ShareLink } from "../ui/ShareLink.tsx";
import { Awards } from "../ui/Awards.tsx";
import { FunNotice } from "../ui/FunNotice.tsx";
import { PickChip, SelfChip } from "../ui/Chips.tsx";
import { PageHead, Tabs } from "../ui/PageHead.tsx";
import { Review, GiftPrompt, wantsGift, markGiftSeen } from "../ui/Review.tsx";
import { useTrip } from "./model.ts";

export default function TripView({ token, config, me: meInfo, reloadMe }: {
  token: string; config: Config | null; me: Me;
  reloadMe: () => void;
}) {
  const vm = useTrip(token);
  const { data, needsPassword, load, actions } = vm;
  const [password, setPassword] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [newName, setNewName] = useState("");
  const [expName, setExpName] = useState("");
  const [expTotal, setExpTotal] = useState("");
  const [expCur, setExpCur] = useState<string | null>(null);
  const [tab, setTab] = useState<"expenses" | "owed" | "youowe" | "fun">("owed");
  const [expPayer, setExpPayer] = useState("");
  const [settle, setSettle] = useState({ from: "", to: "", amount: "" });
  const [showSettings, setShowSettings] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [settleFrom, settleTo] = [settle.from, settle.to];

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

  // ---------- who are you ----------
  // Journey viewers (readOnly) get the claim card on top and the trip below;
  // everyone else must pick a name before seeing content.
  const ClaimCard = () => (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Who are you?</h2>
      <p className="muted">
        Pick your name or add a new one{readOnly ? " — or just browse below" : ""}.{" "}
        {!data.signed_in && <>Without signing in, <b>anyone with the trip link can pick your name later</b>.</>}
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        {data.members.map((m) => (
          <PickChip key={m.id} name={m.name} linked={m.linked}
            disabled={m.linked && !data.signed_in}
            onClick={async () => { await actions.claim({ member_id: m.id }); }} />
        ))}
      </div>
      <div className="row">
        <input className="wide" value={newName} placeholder="Your name"
          onChange={(e) => setNewName(e.target.value)} />
        <button className="primary" disabled={!newName.trim()} onClick={async () => {
          await actions.claim({ name: newName.trim() });
          setNewName("");
        }}>Join as new</button>
      </div>
      {!data.signed_in && (
        <div style={{ marginTop: 14 }}>
          <SignInButton label="Sign in to lock your name" onSignedIn={() => { reloadMe(); load(); }} />
        </div>
      )}
    </div>
  );

  if (!me && !readOnly) {
    return (
      <>
        <h1>{t.name}</h1>
        <ClaimCard />
      </>
    );
  }

  const inviteUrl = `${location.origin}${BASE}/#/t/${token}${t.password ? `?pw=${encodeURIComponent(t.password)}` : ""}`;

  const createExpense = async () => {
    if (!expName.trim() || !expTotal) return;
    const r = await actions.createExpense({
      name: expName.trim(), total_minor: toMinor(expTotal, expCur ?? t.trip_currency),
      currency: expCur ?? t.trip_currency,
      payer_member_id: expPayer || me?.id,
    });
    setExpName(""); setExpTotal("");
    location.hash = `#/t/${token}/e/${r.id}`;
  };

  // Trip Wrapped unlocks at trip end — or 5 days after creation when no end date is set.
  const wrappedAt = t.end_date ? `${t.end_date}T23:59:59` : new Date(new Date(t.created_at).getTime() + 5 * 86400e3).toISOString();
  const wrappedLive = t.fun_leaderboard && Date.now() >= Date.parse(wrappedAt);

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

      {readOnly && !me && <ClaimCard />}
      <div className="row" style={{ marginBottom: 12 }}>
        {me && <SelfChip name={me.name} linked={me.linked} />}
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
        setShow={setShowSettings} />}
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
        ...(wrappedLive ? [["fun", "🎁 Trip Wrapped"] as const] : []),
      ]} />
      {(tab === "owed" || tab === "youowe") && (() => {
        const oweYou = data.balances.filter((p) => p.to === me?.id);
        const youOwe = data.balances.filter((p) => p.from === me?.id);
        const others = data.balances.filter((p) => p.from !== me?.id && p.to !== me?.id);
        const markPaid = async (p: { from: string; to: string; amount: number }) => {
          await actions.settle({
            from_member: p.from, to_member: p.to,
            amount_minor: Math.round(p.amount * 10 ** decimals(t.settle_currency)),
          });
        };
        const Owe = ({ p, dir }: { p: { from: string; to: string; amount: number }; dir: "in" | "out" }) => {
          const other = dir === "in" ? p.from : p.to;
          const m = data.members.find((mm) => mm.id === other);
          const fwd = data.balance_log?.[`${p.from}>${p.to}`] ?? [];
          const [mathOpen, setMathOpen] = useState(false);
          const rev = data.balance_log?.[`${p.to}>${p.from}`] ?? [];
          const entries = [
            ...fwd.map((en) => ({ ...en, sign: 1 })),
            ...rev.map((en) => ({ ...en, sign: -1 })),
          ];
          return (
            <>
              <OweCard name={m?.name ?? "?"} amount={p.amount} currency={t.settle_currency} dir={dir}
                onConfirm={readOnly ? undefined : async () => { await markPaid(p); }}
                onDetails={entries.length ? () => {
                  setMathOpen(true);
                  actions.detailView();
                } : undefined} />
              {mathOpen && (
                <div className="modal-bg" onClick={() => setMathOpen(false)}>
                  <div className="modal" onClick={(e) => e.stopPropagation()}>
                    <h3>{m?.name ?? "?"} · {fmtUnits(p.amount, t.settle_currency)}</h3>
                    <div className="math-list">
                      {entries.map((en, i) => (
                        <div key={i} className="math-row">
                          {(() => {
                            const delta = en.kind === "expense"
                              ? en.sign * (en.converted ?? 0) * 10 ** decimals(t.settle_currency)
                              : en.sign * (en.amount_minor ?? 0);
                            const signChar = delta < 0 ? "−" : "+";
                            return (
                              <>
                                <span>{signChar} {en.kind === "settlement"
                                  ? `${memberName(data.members, en.sign > 0 ? p.from : p.to)} paid ${memberName(data.members, en.sign > 0 ? p.to : p.from)}`
                                  : en.label}</span>
                                <span className="amt muted">
                                  {en.kind === "expense"
                                    ? `${fmt(en.share_minor ?? 0, en.currency ?? "USD")} × ${en.rate ?? "?"} = ${fmtUnits(Math.abs(delta) / 10 ** decimals(t.settle_currency), t.settle_currency)}`
                                    : `${fmt(Math.round(Math.abs(delta)), t.settle_currency)}`}
                                </span>
                              </>
                            );
                          })()}
                        </div>
                      ))}
                      <div className="math-row math-total">
                        <span>= net</span>
                        <span className="amt">{fmtUnits(p.amount, t.settle_currency)}</span>
                      </div>
                    </div>
                    <div className="modal-btns">
                      <button onClick={() => setMathOpen(false)}>close</button>
                    </div>
                  </div>
                </div>
              )}
            </>
          );
        };
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
                  {oweYou.map((p) => <Owe key={p.from} p={p} dir="in" />)}
                </div>
          )}

          {tab === "youowe" && me && (
            youOwe.length === 0
              ? <p className="muted">You owe nobody.</p>
              : <div className="owe-grid">
                  {youOwe.map((p) => <Owe key={p.to} p={p} dir="out" />)}
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
          <details className="more">
            <summary>Record a custom payment</summary>
            <div className="row">
              <select value={settleFrom} onChange={(e) => setSettle({ ...settle, from: e.target.value })}>
                <option value="">From…</option>
                {data.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <select value={settleTo} onChange={(e) => setSettle({ ...settle, to: e.target.value })}>
                <option value="">To…</option>
                {data.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <input className="money" value={settle.amount} placeholder="0.00" inputMode="decimal"
                onChange={(e) => setSettle({ ...settle, amount: e.target.value })} />
              <span className="muted">{t.settle_currency}</span>
              <button className="primary" disabled={!settleFrom || !settleTo || settleFrom === settleTo || !settle.amount}
                onClick={async () => {
                  await actions.settle({
                    from_member: settleFrom, to_member: settleTo,
                    amount_minor: toMinor(settle.amount, t.settle_currency),
                  });
                  setSettle({ from: "", to: "", amount: "" });
                }}>Record</button>
            </div>
          </details>
          )}
        </div>
        );
      })()}

      {tab === "fun" && <Awards title="Trip Wrapped" awards={data.fun?.awards ?? null}
        review={data.fun?.review} currency={t.settle_currency}
        onReplay={data.fun?.review ? () => { markGiftSeen(`wts_reviewed_${token}`); setShowReview(true); } : undefined} />}

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



function Settings({ data, token, currencies, actions, setShow }: {
  data: TripData; token: string; currencies: string[];
  actions: { patchSettings: (p: TripSettingsPatch) => Promise<void>; addMember: (n: string) => Promise<void>; removeMember: (id: string) => Promise<void>; deleteTrip: (n: string) => Promise<void> };
  setShow: (b: boolean) => void;
}) {
  const t = data.trip;
  const [pw, setPw] = useState("");
  const [newMember, setNewMember] = useState("");
  const [delName, setDelName] = useState("");

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <div className="field">
        <label className="field-label">Name</label>
        <input className="wide" defaultValue={t.name} onBlur={async (e) => {
          if (e.target.value !== t.name) { await actions.patchSettings({ name: e.target.value }); }
        }} />
      </div>
      <div className="field"><label className="field-label">Dates</label>
        <SettingsDates t={t} actions={actions} />
      </div>
      <div className="row">
        <div className="field"><label className="field-label">Trip currency</label>
          <div className="locked-field">{flag(t.trip_currency)} {t.trip_currency}</div></div>
        <div className="field"><label className="field-label">Settlement currency</label>
          <div className="locked-field">{flag(t.settle_currency)} {t.settle_currency}</div></div>
      </div>
      <p className="muted" style={{ marginTop: -6 }}>Currencies locked at creation</p>

      <div className="field">
        <label className="field-label">🎁 Trip Wrapped</label>
        {data.is_creator ? (
          <label className="member-chip" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={t.fun_leaderboard} onChange={async (e) => {
              await actions.patchSettings({ fun_leaderboard: e.target.checked });
            }} />
            Show the Trip Wrapped tab with silly awards
          </label>
        ) : (
          <p className="muted">Only the trip creator can toggle this.</p>
        )}
      </div>

      <div className="field">
        <label className="field-label">Trip password</label>
        <div className="row">
          <input type="password" value={pw} placeholder="New trip password"
            onChange={(e) => setPw(e.target.value)} />
          <button disabled={!pw} onClick={async () => {
            await actions.patchSettings({ password: pw });
            setPw("");
          }}>Change</button>
        </div>
        <p className="muted">Every trip keeps a password. Changing it re-prompts every device except signed-in members.</p>
      </div>

      <div className="field">
        <label className="field-label">Members</label>
        {data.members.map((m) => (
          <div key={m.id} className="expense-row">
            <span>{m.name} {m.linked && <span className="pill">🔒 linked</span>} {m.is_me && <span className="pill">(you)</span>}</span>
            {!m.used && !m.is_me && (
              <button className="link danger" onClick={async () => {
                await actions.removeMember(m.id);
              }}>remove</button>
            )}
          </div>
        ))}
        <div className="row">
          <input className="wide" value={newMember} placeholder="Add a placeholder member"
            onChange={(e) => setNewMember(e.target.value)} />
          <button disabled={!newMember.trim()} onClick={async () => {
            await actions.addMember(newMember.trim());
            setNewMember("");
          }}>Add</button>
        </div>
      </div>

      <div className="field">
        <label className="field-label error">Danger zone</label>
        <div className="row">
          <input value={delName} placeholder={`Type "${t.name}" to delete`}
            onChange={(e) => setDelName(e.target.value)} />
          <button className="danger" disabled={delName !== t.name} onClick={async () => {
            await actions.deleteTrip(delName);
            location.hash = "#/";
          }}>Delete trip</button>
        </div>
      </div>
      <button onClick={() => setShow(false)}>Close</button>
    </div>
  );
}
function SettingsDates({ t, actions }: { t: { start_date: string | null; end_date: string | null }; actions: { patchSettings: (p: TripSettingsPatch) => Promise<void> } }) {
  const parse = (s: string | null) => (s ? new Date(s + "T00:00:00") : undefined);
  const [range, setRange] = useState<DateRange | undefined>({ from: parse(t.start_date), to: parse(t.end_date) });
  const save = async (r: DateRange | undefined) => {
    await actions.patchSettings({
      start_date: r?.from ? r.from.toISOString().slice(0, 10) : null,
      end_date: r?.to ? r.to.toISOString().slice(0, 10) : null,
    });
  };
  return (
    <div>
      <RangePicker value={range} onChange={setRange} onCommit={save} />
      {(range?.from || range?.to) && (
        <button className="link" onClick={async () => { setRange(undefined); await save(undefined); }}>Clear dates</button>
      )}
    </div>
  );
}
