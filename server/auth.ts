import { db } from "./db.ts";

// ---------- email-code sign-in ----------
// 4-char code from an unambiguous alphabet, emailed to the user. Codes are
// stored hashed, expire after 10 minutes, allow 5 verify attempts, and are
// single-use. Rate-limited to 3 sends per email per hour.
//
// The Mailer is a seam: prod wires resendMailer, dev wires consoleMailer,
// tests wire captureMailer — one interface, three adapters.

export type Mailer = (to: string, subject: string, text: string) => Promise<void>;

export const resendMailer = (apiKey: string, from: string): Mailer =>
  async (to, subject, text) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) {
      // Keep the provider status — the whole point of this error (e.g. resend_403
      // when EMAIL_FROM uses an unverified domain).
      const detail = await res.text().catch(() => "");
      throw new Error(`resend_${res.status}${detail ? ` ${detail}` : ""}`);
    }
  };

export const consoleMailer: Mailer = async (to, _subject, text) => {
  console.log(`[email:dev] to ${to}: ${text.trim()}`);
};

export type SentMail = { to: string; subject: string; text: string };
export const captureMailer = (sent: SentMail[] = []): { mailer: Mailer; sent: SentMail[] } => ({
  mailer: async (to, subject, text) => { sent.push({ to, subject, text }); },
  sent,
});

const CODE_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;

const now = () => new Date().toISOString();

function newCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return [...b].map((x) => CODE_ALPHA[x % CODE_ALPHA.length]).join("");
}

export type SendResult = "ok" | "rate_limited" | "send_failed";
export type CheckResult = "ok" | "no_code" | "code_expired" | "too_many_attempts" | "wrong_code";

export function createAuth({ mailer, baseUrl, sendLog = new Map<string, number[]>() }: {
  mailer: Mailer;
  baseUrl: string;
  sendLog?: Map<string, number[]>;
}) {
  return {
    /** Issue a code: 3 sends per email per hour, then email it. Nothing stored on send failure. */
    async sendCode(email: string): Promise<SendResult> {
      const nowMs = Date.now();
      const sends = (sendLog.get(email) ?? []).filter((t) => nowMs - t < 3600e3);
      if (sends.length >= 3) return "rate_limited";
      sends.push(nowMs);
      sendLog.set(email, sends);
      const code = newCode();
      try {
        await mailer(
          email,
          `Your WatsTheSplit code: ${code}`,
          `Your sign-in code is ${code} (valid 10 minutes).\n\nOpen WatsTheSplit: ${baseUrl}/\n`,
        );
      } catch (e) {
        console.error("send failed:", e);
        return "send_failed";
      }
      db.run(
        "INSERT OR REPLACE INTO email_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?,?,?,0,?)",
        [email, await Bun.password.hash(code), new Date(nowMs + CODE_TTL_MS).toISOString(), now()],
      );
      return "ok";
    },

    /** Check a code: single-use, 5 attempts, 10-minute TTL. Deletes the row on success. */
    async checkCode(email: string, code: string): Promise<CheckResult> {
      const row = db.query<{ code_hash: string; expires_at: string; attempts: number }, [string]>(
        "SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?",
      ).get(email);
      if (!row) return "no_code";
      if (Date.parse(row.expires_at) < Date.now()) return "code_expired";
      if (row.attempts >= CODE_MAX_ATTEMPTS) return "too_many_attempts";
      const ok = await Bun.password.verify(code.trim().toUpperCase(), row.code_hash);
      if (!ok) {
        db.run("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?", [email]);
        return "wrong_code";
      }
      db.run("DELETE FROM email_codes WHERE email = ?", [email]);
      return "ok";
    },
  };
}
