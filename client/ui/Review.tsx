import React, { useState } from "react";
import type { Award, TripReview } from "../api.ts";
import { CATEGORIES, fmtUnits } from "../format.ts";

// Trip in Review: the Wrapped story — one stat or award per card, tapped
// through like a story reel. Opens from the 🎁 prompt or the Wrapped-tab
// replay button; the last card lands back on the full Wrapped tab.
export function Review({ title, subtitle, review, awards, onClose }: {
  title: string; subtitle: string;
  review: TripReview | undefined; awards: Award[];
  onClose: () => void;
}) {
  const cards: React.ReactNode[] = [];
  if (review) {
    cards.push(
      <Card key="cover" emoji="🎁" big={title}
        lines={[subtitle, "your trip in review — tap to begin"]} />,
      <Card key="total" emoji="💰" big={review.total}
        lines={[`${review.expenseCount} expense${review.expenseCount === 1 ? "" : "s"}`,
          review.currencies.length > 1 ? `across ${review.currencies.join(" · ")}` : `all in ${review.currencies[0] ?? ""}`]} />,
    );
    if (review.biggest || review.biggestDay) {
      const lines: string[] = [];
      if (review.biggest) lines.push(`biggest expense: ${review.biggest.name} · ${review.biggest.total}`);
      if (review.biggestDay) lines.push(`biggest day: ${new Date(review.biggestDay.date + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric" })} · ${review.biggestDay.total}`);
      cards.push(<Card key="peak" emoji="🏔️" big="peak damage" lines={lines} />);
    }
    if (review.categories.length) {
      const max = Math.max(...review.categories.map((c) => c.units));
      cards.push(
        <Card key="cats" emoji="🧺" big="where the money went" lines={[]}>
          {review.categories.slice(0, 5).map((c) => (
            <div key={c.cat} className="rcat">
              <span className="rcat-label">{CATEGORIES[c.cat] ?? "📦"} {c.cat}</span>
              <span className="rcat-bar"><span style={{ width: `${(c.units / max) * 100}%` }} /></span>
            </div>
          ))}
        </Card>,
      );
    }
    if (review.members.length > 1) {
      cards.push(
        <Card key="members" emoji="👥" big="who spent what" lines={
          review.members.slice(0, 5).map((m) => `${m.name}: ${m.consumed}${m.count > 0 ? ` · ${m.count} splits` : ""}`)
        } />,
      );
    }
  }
  awards.slice(0, 3).forEach((a, i) => {
    cards.push(
      <Card key={`aw${i}`} emoji={a.emoji} big={a.title}
        lines={[a.members.join(" + ") || "the whole squad", a.detail]} />,
    );
  });
  // final card: back to the full Wrapped tab
  cards.push(
    <Card key="cta" emoji="📊" big="that's the gist"
      lines={["the full numbers and every award live on the Wrapped tab"]} cta="See your full Wrapped" />,
  );

  const [i, setI] = useState(0);
  const advance = () => { if (i + 1 < cards.length) setI(i + 1); else onClose(); };
  const back = () => { if (i > 0) setI(i - 1); };

  return (
    <div className="review-overlay" onClick={onClose}>
      <div className="review-stage" onClick={(e) => e.stopPropagation()}>
        <div className="review-dots">
          {cards.map((_, j) => <span key={j} className={j === i ? "on" : ""} />)}
        </div>
        <button className="review-close" onClick={onClose}>✕</button>
        <div className="review-nav left" onClick={back} />
        <div className="review-nav right" onClick={advance} />
        <div className="review-card" onClick={advance}>{cards[i]}</div>
      </div>
    </div>
  );
}

function Card({ emoji, big, lines, cta, children }: {
  emoji: string; big: string; lines: string[];
  cta?: string; children?: React.ReactNode;
}) {
  return (
    <div className="rcard-inner">
      <div className="rcard-emoji">{emoji}</div>
      <div className="rcard-big">{big}</div>
      {lines.filter(Boolean).map((l, j) => <div key={j} className="rcard-line">{l}</div>)}
      {children}
      {cta && <div className="rcard-cta">{cta} →</div>}
    </div>
  );
}

// Mid-screen 🎁 prompt: pops once Wrapped is live, reappears every visit
// until the story is opened (flag is written by the caller on open).
export function GiftPrompt({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <div className="modal-bg" onClick={onOpen}>
      <div className="modal gift-prompt" onClick={(e) => e.stopPropagation()}>
        <div className="gift-emoji">🎁</div>
        <h3 style={{ margin: "4px 0" }}>{title} is live</h3>
        <p className="muted">your trip in review — the numbers and awards from everything you logged</p>
        <button className="primary" onClick={onOpen}>Open it</button>
      </div>
    </div>
  );
}

// Whether the 🎁 prompt should show: Wrapped live + story not yet opened on
// this device. `storageKey` distinguishes trip vs journey recaps.
export function wantsGift(storageKey: string): boolean {
  return !localStorage.getItem(storageKey);
}
export function markGiftSeen(storageKey: string) {
  localStorage.setItem(storageKey, "1");
}
