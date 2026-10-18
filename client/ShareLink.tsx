import React, { useMemo } from "react";
import qrcode from "qrcode-generator";
import { CopyButton } from "./CopyButton.tsx";

// The share card for a Trip Link or Journey Link: copyable URL, QR code, privacy note.
export function ShareLink({ url, note }: { url: string; note: string }) {
  const qr = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(url);
    q.make();
    return q.createDataURL(8, 0);
  }, [url]);
  return (
    <div className="card">
      <div className="row">
        <input className="wide" readOnly value={url} onFocus={(e) => e.target.select()} />
        <CopyButton text={url} />
      </div>
      <div className="qr"><img src={qr} alt="QR code for this link" /></div>
      <p className="muted">{note}</p>
    </div>
  );
}
