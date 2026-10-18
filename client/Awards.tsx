import React from "react";

export type Award = { emoji: string; title: string; members: string[]; detail: string };

// Awards board shared by Trip Wrapped and Journey Wrapped: hero card + grid.
export function Awards({ title, awards }: { title: string; awards: Award[] | null }) {
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>🎁 {title}</h2>
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
