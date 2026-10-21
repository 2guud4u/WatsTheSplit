import React, { useState } from "react";

// "Wrapped is on" notice shown while awards are live. Dismissal persists in
// localStorage under storageKey; `hidden` renders the "you're hidden" pill
// instead of the opt-out button. children = the notice copy (varies per view).
export function FunNotice({ storageKey, hidden, onHide, children }: {
  storageKey: string; hidden: boolean | undefined;
  onHide: () => Promise<void> | void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => !localStorage.getItem(storageKey));
  if (!open) return null;
  return (
    <div className="card fun-notice">
      <p className="muted" style={{ margin: 0 }}>{children}</p>
      <div className="row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
        {hidden
          ? <span className="pill">you're hidden from awards</span>
          : <button className="link" onClick={async () => { await onHide(); }}>hide me from awards</button>}
        <button className="link" onClick={() => {
          localStorage.setItem(storageKey, "1");
          setOpen(false);
        }}>dismiss</button>
      </div>
    </div>
  );
}
