import React, { useState } from "react";
import { api } from "../api.ts";

// Email-code sign-in: type email → we send a 4-char code → type it → signed in.
export function SignIn({ onSignedIn, compact }: { onSignedIn: () => void; compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!email.includes("@")) { setErr("Enter a valid email"); return; }
    setBusy(true); setErr("");
    try {
      await api.call("POST /api/auth/email", { email: email.trim() });
      setSent(true);
    } catch (e) { setErr(e instanceof Error ? e.message : "send failed"); }
    setBusy(false);
  };

  const verify = async () => {
    setBusy(true); setErr("");
    try {
      const failure = await api.call("POST /api/auth/email/verify", { email: email.trim(), code: code.trim() }, {
        wrong_code: () => "Wrong code — check the email",
        code_expired: () => "Code expired — send a new one",
      });
      if (typeof failure === "string") setErr(failure);
      else onSignedIn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "verify failed");
    }
    setBusy(false);
  };

  if (!sent) {
    return (
      <div className={compact ? "" : "card"}>
        <div className="row">
          <input className="wide" type="email" value={email} placeholder="you@example.com"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()} />
          <button className="primary" onClick={send} disabled={busy || !email.includes("@")}>
            {busy ? "…" : "Send code"}
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        {!compact && <p className="muted" style={{ margin: "6px 0 0" }}>We'll email you a 4-letter code — no password.</p>}
      </div>
    );
  }
  return (
    <div className={compact ? "" : "card"}>
      <p className="muted" style={{ margin: "0 0 8px" }}>Code sent to <b>{email}</b> — check inbox/spam.</p>
      <div className="row">
        <input className="wide" value={code} placeholder="4-letter code" maxLength={4}
          style={{ textTransform: "uppercase", letterSpacing: "0.4em", fontWeight: 700 }}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && verify()}
          autoFocus />
        <button className="primary" onClick={verify} disabled={busy || code.length !== 4}>
          {busy ? "…" : "Sign in"}
        </button>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="link" onClick={() => { setSent(false); setCode(""); setErr(""); }}>different email</button>
        <button className="link" onClick={send} disabled={busy}>resend</button>
      </div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

// Button that opens the sign-in flow in a modal.
export function SignInButton({ onSignedIn, label = "Sign in" }: { onSignedIn: () => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="link" onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <div className="modal-bg" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Sign in</h3>
            <SignIn onSignedIn={() => { setOpen(false); onSignedIn(); }} />
          </div>
        </div>
      )}
    </>
  );
}
