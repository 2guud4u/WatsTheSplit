import type { TripView as TripData } from "../services/api.ts";

type SettleState = { from: string; to: string; amount: string };

// "Record a custom payment" card (the settlement card). Rendered on the
// "you owe" tab for a signed-in member: pick two members + an amount, then
// record a settlement. Owns no state — the draft lives in the parent (so the
// switch-modal's draft-discard check and reset still see it).
export function SettleCard({ data, settle, setSettle, record }: {
  data: TripData;
  settle: SettleState;
  setSettle: (s: SettleState) => void;
  record: (p: { from: string; to: string; amount: string }) => Promise<void>;
}) {
  return (
    <details className="more">
      <summary>Record a custom payment</summary>
      <div className="row">
        <select value={settle.from} onChange={(e) => setSettle({ ...settle, from: e.target.value })}>
          <option value="">From…</option>
          {data.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select value={settle.to} onChange={(e) => setSettle({ ...settle, to: e.target.value })}>
          <option value="">To…</option>
          {data.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <input className="money" value={settle.amount} placeholder="0.00" inputMode="decimal"
          onChange={(e) => setSettle({ ...settle, amount: e.target.value })} />
        <span className="muted">{data.trip.settle_currency}</span>
        <button className="primary" disabled={!settle.from || !settle.to || settle.from === settle.to || !settle.amount}
          onClick={async () => {
            await record({ from: settle.from, to: settle.to, amount: settle.amount });
            setSettle({ from: "", to: "", amount: "" });
          }}>Record</button>
      </div>
    </details>
  );
}
