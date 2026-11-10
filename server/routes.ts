// Shared route context. The closure values that every route handler needs (the
// Response helpers, the lazy prepared statements, the payment/member helpers,
// and the auth object) are carried here; module-level helpers (db, mutate,
// resolveTrip, ledger, wrapped, …) are imported directly by each domain module.
import type { ErrorCode } from "../shared/wire.ts";
import type { Session, Member, Trip, Journey, ExpenseRow } from "./types.ts";
import type { Auth } from "./auth.ts";

export type Body = Record<string, unknown>;
export type Route = [
  RegExp,
  string,
  (req: Request, m: RegExpMatchArray, body: Body, s: Session) => Promise<Response> | Response,
];

export type RouteCtx = {
  json: (data: unknown, init?: ResponseInit) => Response;
  err: (status: number, error: ErrorCode, extra?: object) => Response;
  now: () => string;
  baseUrl: string;
  qMember: { get: (id: string) => Member | null };
  qTrip: { get: (t: string) => Trip | null };
  qJourney: { get: (t: string) => Journey | null };
  qExpense: { get: (id: string) => ExpenseRow | null };
  qItem: { get: (id: string) => { id: string; expense_id: string; name: string; price_minor: number } | null };
  qPhoto: { get: (id: string) => { id: string; expense_id: string; mime: string; data: Uint8Array } | null };
  paymentOfMember: (m: Member) => { phone: string | null; venmo: string | null; cash_app: string | null } | null;
  memberIsUsed: (tripToken: string, memberId: string) => boolean;
  nameTaken: (tripToken: string, name: string, excludeId?: string) => boolean;
  auth: Auth;
};
