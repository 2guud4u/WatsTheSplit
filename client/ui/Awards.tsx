import React from "react";
import type { Award, TripReview } from "../api.ts";
import { CATEGORIES, decimals, fmtUnits } from "../format.ts";

// Awards board shared by Trip Wrapped and Journey Wrapped: stats review on
// top (the "Trip in Review" numbers), hero card + award grid below.
export function Awards({ title, awards, review, currency, onReplay }: {
  title: string; awards: Award[] | null; review?: TripReview | null;
  currency?: string; onReplay?: () => void;
}) {
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ marginTop: 0 }}>🎁 {title}</h2>
        {onReplay && <button className="link" onClick={onReplay}>▶ replay trip in review</button>}
      </div>
      {review && <ReviewPanel review={review} currency={currency} />}
      {(!awards || awards.length === 0) && (
        <p className="muted">No awards yet — add expenses and let the data speak.</p>
      )}
      {awards && awards.length > 0 && (
        <>
          <div className="award-hero">
            <div className="award-emoji">{awards[0].emoji}</div>
            <div className="award-title">{awards[0].title}</div>
            <div className="award-members">{awards[0].members.join(" + ")}</div>
            <div className="muted">{awards[0].detail}</div>
          </div>
          <div className="award-grid">
            {awards.slice(1).map((a) => (
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
  );
}

// The numbers layer of Wrapped: totals, category breakdown, daily spend
// sparkline, per-member lines — the same stats the card story previews.
export function ReviewPanel({ review, currency }: { review: TripReview; currency?: string }) {
  const cur = currency ?? "";
  const units = (v: number) => fmtUnits(v, cur);
  const catMax = Math.max(...review.categories.map((c) => c.units), 1);
  const dayMax = Math.max(...review.daily.map((d) => d.units), 1);
  return (
    <div className="review-panel">
      <div className="review-hero">
        <div className="review-total">{review.total}</div>
        <div className="muted">{review.expenseCount} expense{review.expenseCount === 1 ? "" : "s"}
          {review.currencies.length > 1 && ` across ${review.currencies.length} currencies`}
        </div>
      </div>

      {(review.biggest || review.biggestDay) && (
        <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
          {review.biggest && (
            <div className="review-fact">
              <div className="muted">biggest single expense</div>
              <div><b>{review.biggest.name}</b> · {review.biggest.total}</div>
            </div>
          )}
          {review.biggestDay && (
            <div className="review-fact">
              <div className="muted">biggest day</div>
              <div><b>{new Date(review.biggestDay.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</b> · {review.biggestDay.total}</div>
            </div>
          )}
        </div>
      )}

      {review.categories.length > 0 && (
        <div className="review-cats">
          {review.categories.slice(0, 4).map((c) => (
            <div key={c.cat} className="review-cat">
              <span>{CATEGORIES[c.cat] ?? "📦"} {c.cat}</span>
              <span className="review-bar" style={{ width: `${Math.max(4, (c.units / catMax) * 100)}%` }} />
              <span className="muted">{units(c.units)}</span>
            </div>
          ))}
        </div>
      )}

      {review.daily.length > 1 && (
        <div className="review-days">
          {review.daily.map((d) => (
            <div key={d.day} className="review-day" title={`${d.day}: ${units(d.units)}`}
              style={{ height: `${Math.max(8, (d.units / dayMax) * 48)}px` }} />
          ))}
        </div>
      )}

      {review.members.length > 0 && (
        <div className="review-members">
          {review.members.map((m) => (
            <div key={m.name} className="expense-row">
              <span>{m.name}</span>
              <span className="muted">spent {m.consumed}{m.count > 0 && ` · in on ${m.count}`}{m.covered !== m.consumed && ` · fronted ${m.covered}`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
