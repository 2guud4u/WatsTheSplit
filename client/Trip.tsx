import React, { useEffect, useRef, useState, useCallback } from "react";
import { api, BASE, Config, toMinor, fmt, fmtUnits, decimals, flag, CATEGORIES } from "./api.ts";
import { addRecent } from "./main.tsx";
import { CurrencyPicker } from "./CurrencyPicker.tsx";
import { Avatar, OweCard, memberName } from "./OweCard.tsx";
import { SignInButton } from "./SignIn.tsx";
import { RangePicker } from "./main.tsx";
import type { DateRange } from "react-day-picker";
import { useTripEvents } from "./hooks.ts";
import { ShareLink } from "./ShareLink.tsx";
type Member = { id: string; name: string; linked: boolean; used: boolean; is_me: boolean; opted_out_fun?: boolean };
type ExpenseSum = {
  id: string; name: string; currency: string; total_minor: number;
  payer_member_id: string | null; category: string | null; unassigned_minor: number; over: boolean; paid_out?: boolean; paid_count?: number; share_count?: number;
  rate: number | null;
};
type Settlement = { id: string; from_member: string; to_member: string; amount_minor: number };
type TripData = {
  trip: {
    token: string; name: string; start_date: string | null; end_date: string | null;
    created_at: string;
    trip_currency: string; settle_currency: string; has_password: boolean; password: string | null; fun_leaderboard: boolean;
  };
  me: { id: string; name: string; linked: boolean; opted_out_fun?: boolean } | null;
  access: "edit" | "view";
  journey: { token: string; name: string } | null;
  signed_in: boolean;
  is_creator: boolean;
  fun: { awards: { emoji: string; title: string; members: string[]; detail: string }[] } | null;
  members: Member[];
  balances: { from: string; to: string; amount: number }[];
  balance_log: Record<string, {
    kind: "expense" | "settlement"; label: string;
    share_minor?: number; currency?: string; rate?: number | null;
    converted?: number; amount_minor?: number;
  }[]>;
  no_rate_count: number;
  unfinished_count: number;
  expenses: ExpenseSum[];
  settlements: Settlement[];
  fx_timestamp: string | null;
  current_rate: { rate: number; providerTimestamp: string | null } | null;
};

function MoneyInput({ code, value, onCommit, placeholder }: {
  code: string; value: string; placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input className="money" value={v} placeholder={placeholder}
      inputMode="decimal"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
  );
}

export default function TripView({ token, config, me: meInfo, reloadMe }: {
  token: string; config: Config | null; me: { user: { email: string; name: string | null } | null };
  reloadMe: () => void;
}) {
  const [data, setData] = useState<TripData | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [newName, setNewName] = useState("");
  const [expName, setExpName] = useState("");
  const [expTotal, setExpTotal] = useState("");
  const [expCur, setExpCur] = useState<string | null>(null);
  const [tab, setTab] = useState<"expenses" | "owed" | "youowe" | "fun">("owed");
  const [expPayer, setExpPayer] = useState("");
  const [settle, setSettle] = useState({ from: "", to: "", amount: "" });
  const [funBanner, setFunBanner] = useState(() =>
    !localStorage.getItem(`wts_fun_notice_${token}`));
  const [showSettings, setShowSettings] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const [settleFrom, settleTo] = [settle.from, settle.to];

  const load = useCallback(async () => {
    try {
      const d = await api.get(`/api/trips/${token}`);
      setData(d);
      setNeedsPassword(false);
      addRecent(token, d.trip.name);
      if (d.trip && expCur === null) setExpCur(d.trip.trip_currency);
    } catch (e) {
      const err = e as { status?: number; data?: { error?: string } };
      if (err.status === 401 && err.data?.error === "password_required") setNeedsPassword(true);
    }
  }, [token]);

  useEffect(() => {
    (async () => {
      // Share links carry ?pw= in the hash (never sent to the server). POST it
      // BEFORE the first load: both would otherwise race to create separate
      // anonymous sessions and consent could land on the losing cookie.
      const m = /\?pw=([^&]*)/.exec(location.hash);
      if (m) {
        const pw = decodeURIComponent(m[1]);
        history.replaceState(null, "", location.pathname + location.search + location.hash.replace(/\?pw=[^&]*/, ""));
        await api.post(`/api/trips/${token}/password`, { password: pw }).catch(() => {});
      }
      load();
    })();
    const onFocus = () => load();
    addEventListener("focus", onFocus);
    return () => { removeEventListener("focus", onFocus); };
  }, [token]);
  useTripEvents([token], load);

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
              try {
                await api.post(`/api/trips/${token}/password`, { password });
                setNeedsPassword(false); load();
              } catch { setPwErr("Wrong password"); }
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
          <button key={m.id} className="member-chip"
            disabled={m.linked && !data.signed_in}
            onClick={async () => { await api.post(`/api/trips/${token}/claim`, { member_id: m.id }); load(); }}>
            <Avatar name={m.name} />{m.name}{m.linked && <span className="pill">🔒</span>}
          </button>
        ))}
      </div>
      <div className="row">
        <input className="wide" value={newName} placeholder="Your name"
          onChange={(e) => setNewName(e.target.value)} />
        <button className="primary" disabled={!newName.trim()} onClick={async () => {
          await api.post(`/api/trips/${token}/claim`, { name: newName.trim() });
          setNewName(""); load();
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

  const myPairs = data.balances.filter((p) => p.from === me?.id || p.to === me?.id);
  const inviteUrl = `${location.origin}${BASE}/#/t/${token}${t.password ? `?pw=${encodeURIComponent(t.password)}` : ""}`;

  const createExpense = async () => {
    if (!expName.trim() || !expTotal) return;
    const r = await api.post(`/api/trips/${token}/expenses`, {
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
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ marginBottom: 4 }}>{t.name}</h1>
        <a href="#/" className="muted">← home</a>
      </div>
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
        {me && <span className="member-chip"><Avatar name={me.name} /><b>{me.name}</b>{me.linked ? " ✓" : ""}</span>}
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

      {showSettings && <Settings data={data} token={token} currencies={currencies} reload={load}
        setShow={setShowSettings} />}
      {wrappedLive && funBanner && (
        <div className="card fun-notice">
          <p className="muted" style={{ margin: 0 }}>
            🎁 <b>Trip Wrapped</b> is on — the trip creator enabled silly awards from this trip's expense data (who pays, owes, drinks, eats).
          </p>
          <div className="row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
            {me?.opted_out_fun
              ? <span className="pill">you're hidden from awards</span>
              : <button className="link" onClick={async () => {
                  await api.patch(`/api/members/${me?.id}`, { opted_out_fun: true });
                  load();
                }}>hide me from awards</button>}
            <button className="link" onClick={() => {
              localStorage.setItem(`wts_fun_notice_${token}`, "1");
              setFunBanner(false);
            }}>dismiss</button>
          </div>
        </div>
      )}


      <div className="tabs">
        <button className={tab === "expenses" ? "active" : ""} onClick={() => setTab("expenses")}>Expenses</button>
        <button className={tab === "owed" ? "active" : ""} onClick={() => setTab("owed")}>Who owes you</button>
        <button className={tab === "youowe" ? "active" : ""} onClick={() => setTab("youowe")}>Who you owe</button>
        {wrappedLive && (
          <button className={tab === "fun" ? "active" : ""} onClick={() => setTab("fun")}>🎁 Trip Wrapped</button>
        )}
      </div>
      {(tab === "owed" || tab === "youowe") && (() => {
        const oweYou = data.balances.filter((p) => p.to === me?.id);
        const youOwe = data.balances.filter((p) => p.from === me?.id);
        const others = data.balances.filter((p) => p.from !== me?.id && p.to !== me?.id);
        const markPaid = async (p: { from: string; to: string; amount: number }) => {
          await api.post(`/api/trips/${token}/settlements`, {
            from_member: p.from, to_member: p.to,
            amount_minor: Math.round(p.amount * 10 ** decimals(t.settle_currency)),
          });
          load();
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
                  api.post(`/api/trips/${token}/detail-view`).catch(() => {});
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
                      await api.del(`/api/settlements/${s.id}`);
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
                  await api.post(`/api/trips/${token}/settlements`, {
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

      {tab === "fun" && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>🎁 Trip Wrapped</h2>
          {(!data.fun || data.fun.awards.length === 0) && (
            <p className="muted">No awards yet — add expenses and let the data speak.</p>
          )}
          {data.fun && data.fun.awards.length > 0 && (
            <>
              {(() => {
                const first = data.fun.awards[0];
                return (
                  <div className="award-hero">
                    <div className="award-emoji">{first.emoji}</div>
                    <div className="award-title">{first.title}</div>
                    <div className="award-members">{first.members.join(" + ")}</div>
                    <div className="muted">{first.detail}</div>
                  </div>
                );
              })()}
              <div className="award-grid">
                {data.fun.awards.slice(1).map((a) => (
                  <div key={a.title} className="award-card">
                    <div className="award-emoji">{a.emoji}</div>
                    <div className="award-title">{a.title}</div>
                    <div className="award-members">{a.members.join(" + ") || "the whole squad"}</div>
                    <div className="muted">{a.detail}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
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



function Settings({ data, token, currencies, reload, setShow }: {
  data: TripData; token: string; currencies: string[];
  reload: () => void; setShow: (b: boolean) => void;
}) {
  const t = data.trip;
  const [pw, setPw] = useState("");
  const [newMember, setNewMember] = useState("");
  const [delName, setDelName] = useState("");
  const hasExpenses = data.expenses.length > 0;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <div className="field">
        <label className="field-label">Name</label>
        <input className="wide" defaultValue={t.name} onBlur={async (e) => {
          if (e.target.value !== t.name) { await api.patch(`/api/trips/${token}/settings`, { name: e.target.value }); reload(); }
        }} />
      </div>
      <div className="field"><label className="field-label">Dates</label>
        <SettingsDates t={t} token={token} reload={reload} />
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
              await api.patch(`/api/trips/${token}/settings`, { fun_leaderboard: e.target.checked });
              reload();
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
            await api.patch(`/api/trips/${token}/settings`, { password: pw });
            setPw(""); reload();
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
                await api.del(`/api/members/${m.id}`); reload();
              }}>remove</button>
            )}
          </div>
        ))}
        <div className="row">
          <input className="wide" value={newMember} placeholder="Add a placeholder member"
            onChange={(e) => setNewMember(e.target.value)} />
          <button disabled={!newMember.trim()} onClick={async () => {
            await api.post(`/api/trips/${token}/members`, { name: newMember.trim() });
            setNewMember(""); reload();
          }}>Add</button>
        </div>
      </div>

      <div className="field">
        <label className="field-label error">Danger zone</label>
        <div className="row">
          <input value={delName} placeholder={`Type "${t.name}" to delete`}
            onChange={(e) => setDelName(e.target.value)} />
          <button className="danger" disabled={delName !== t.name} onClick={async () => {
            await api.del(`/api/trips/${token}`, { name: delName });
            location.hash = "#/";
          }}>Delete trip</button>
        </div>
      </div>
      <button onClick={() => setShow(false)}>Close</button>
    </div>
  );
}
function SettingsDates({ t, token, reload }: { t: { start_date: string | null; end_date: string | null }; token: string; reload: () => void }) {
  const parse = (s: string | null) => (s ? new Date(s + "T00:00:00") : undefined);
  const [range, setRange] = useState<DateRange | undefined>({ from: parse(t.start_date), to: parse(t.end_date) });
  const save = async (r: DateRange | undefined) => {
    await api.patch(`/api/trips/${token}/settings`, {
      start_date: r?.from ? r.from.toISOString().slice(0, 10) : null,
      end_date: r?.to ? r.to.toISOString().slice(0, 10) : null,
    });
    reload();
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
