import type {
  AccessibleTrip, Award, Config, ErrorCode, ExpenseView, JourneyView,
  MemberSuggestions, Me, MyJourneys, MyTrips, TripView, Ok,
  NewTrip, TripSettingsPatch, ClaimInput, NewExpense, ExpensePatch,
  NewSettlement, ItemPatch, NewItem, SplitInput, MemberPatch,
  NewJourney, JourneySettingsPatch,
} from "../shared/wire.ts";
export type * from "../shared/wire.ts";

// Deployed under BASE_PATH (e.g. /watsthesplit) — vite base bakes it into
// import.meta.env.BASE_URL; strip its trailing slash for path joins.
export const BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");

// ---------- errors ----------

export class ApiError<C extends string = ErrorCode> extends Error {
  readonly status: number;                    // 0 = network failure
  readonly code: C;
  readonly data: Record<string, unknown>;     // extra server fields, e.g. { protected: true }
  constructor(status: number, code: C, data: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export function isApiError<K extends string, P extends string>(e: unknown, ...codes: P[]): e is ApiError<P> {
  return e instanceof ApiError && (codes.length === 0 || codes.includes(e.code as P));
}

// Human copy for error codes — one catalog instead of per-site mapping.
const COPY: Partial<Record<ErrorCode | "network" | "bad_response", string>> = {
  bad_email: "That doesn't look like an email address",
  too_many_codes: "Too many codes sent — wait a bit and try again",
  send_failed: "Couldn't send the email — try again later",
  no_code: "Send a code first",
  code_expired: "Code expired — send a new one",
  too_many_attempts: "Too many tries — send a new code",
  wrong_code: "Wrong code — check the email",
  password_required: "This trip is locked — enter its password",
  wrong_password: "Wrong password",
  no_access: "You don't have access to this journey",
  name_taken: "Name taken — pick another",
  member_linked: "That member is linked to another account",
  already_linked_other_member: "You're already linked to a different member in this trip",
  member_in_use: "That member is used by expenses or settlements",
  cannot_remove_self: "You can't remove yourself",
  name_mismatch: "The name doesn't match — type it exactly to confirm",
  currencies_locked: "Currencies are set at creation only",
  only_creator: "Only the trip creator can change that",
  bad_currency: "Unknown currency",
  bad_total: "Enter a valid total",
  bad_payer: "Pick someone in this trip",
  bad_members: "Pick two different members of this trip",
  bad_amount: "Enter a positive amount",
  member_or_name_required: "Pick a member or type a new name",
  need_two_members: "Pick at least two members to merge",
  no_trips: "Pick at least one trip",
  settle_currency_mismatch: "All trips must settle in the same currency",
  already_in_journey: "That trip is already in a journey",
  not_image: "That file isn't an image",
  too_large: "Photo is over 10 MB",
  payer_only: "Only the payer can mark this paid",
  payer_or_self_only: "Only the payer or that person can change this",
  not_your_member: "You can only change your own member",
  network: "Can't reach the server — check your connection",
  bad_response: "Unexpected server response",
  trip_not_found: "Trip not found",
  expense_not_found: "Expense not found",
  journey_not_found: "Journey not found",
  member_not_found: "Member not found",
};

export function describeError(e: unknown, overrides: Partial<Record<ErrorCode, string>> = {}): string {
  if (e instanceof ApiError) {
    const o = overrides[e.code as ErrorCode];
    if (o) return o;
    const c = COPY[e.code as ErrorCode];
    if (c) return c;
    return `${e.code} (${e.status})`;
  }
  return e instanceof Error ? e.message : "Something went wrong";
}

// ---------- route table (type-only; zero runtime bytes) ----------

type R<Body, Res, Err extends string = never> = { body: Body; res: Res; err: Err };
type TripGate = "trip_not_found" | "password_required";
type JourneyGate = "journey_not_found" | "no_access";

interface Routes {
  "GET /api/config":                 R<{}, Config>;
  "GET /api/me":                     R<{}, Me>;
  "POST /api/auth/email":            R<{ email: string }, Ok, "bad_email" | "too_many_codes" | "send_failed">;
  "POST /api/auth/email/verify":     R<{ email: string; code: string }, Ok, "no_code" | "code_expired" | "too_many_attempts" | "wrong_code">;
  "POST /api/auth/signout":          R<{}, Ok>;
  "GET /api/my-trips":               R<{}, MyTrips>;
  "GET /api/my-journeys":            R<{}, MyJourneys>;
  "GET /api/accessible-trips":       R<{}, { trips: AccessibleTrip[] }>;
  "GET /api/member-suggestions":     R<{}, MemberSuggestions>;

  "POST /api/trips":                 R<NewTrip, { token: string; url: string }, "name_required" | "bad_currency" | "password_required">;
  "GET /api/trips/:trip":            R<{}, TripView, TripGate>;
  "DELETE /api/trips/:trip":         R<{ name: string }, Ok, TripGate | "name_mismatch">;
  "POST /api/trips/:trip/password":  R<{ password: string }, Ok, "trip_not_found" | "wrong_password">;
  "PATCH /api/trips/:trip/settings": R<TripSettingsPatch, Ok, TripGate | "currencies_locked" | "only_creator">;
  "POST /api/trips/:trip/claim":     R<ClaimInput, { ok: true; member_id: string },
                                       TripGate | "member_not_found" | "member_linked" | "name_taken" | "already_linked_other_member" | "member_or_name_required">;
  "POST /api/trips/:trip/members":   R<{ name: string }, { id: string }, TripGate | "name_required" | "name_taken">;
  "POST /api/trips/:trip/detail-view": R<{}, Ok, TripGate>;
  "POST /api/trips/:trip/expenses":  R<NewExpense, { id: string }, TripGate | "name_required" | "bad_currency" | "bad_total" | "bad_payer">;
  "POST /api/trips/:trip/settlements": R<NewSettlement, { id: string }, TripGate | "bad_members" | "bad_amount">;

  "PATCH /api/members/:member":      R<MemberPatch, Ok, TripGate | "member_not_found" | "name_required" | "name_taken" | "not_your_member">;
  "DELETE /api/members/:member":     R<{}, Ok, TripGate | "member_not_found" | "member_in_use" | "cannot_remove_self">;

  "GET /api/expenses/:expense":      R<{}, ExpenseView, "expense_not_found" | "password_required">;
  "PATCH /api/expenses/:expense":    R<ExpensePatch, Ok, "expense_not_found" | "password_required" | "bad_total" | "bad_payer" | "payer_only" | "bad_currency">;
  "DELETE /api/expenses/:expense":   R<{}, Ok, "expense_not_found" | "password_required">;
  "PUT /api/expenses/:expense/paid":         R<{ member_id: string; paid: boolean }, Ok, "expense_not_found" | "password_required" | "member_not_found" | "payer_or_self_only">;
  "PUT /api/expenses/:expense/participants": R<{ member_id: string; on: boolean }, Ok, "expense_not_found" | "password_required" | "member_not_found">;
  "PUT /api/expenses/:expense/shares":       R<{ member_id: string; share_minor: number | null }, Ok, "expense_not_found" | "password_required" | "member_not_found">;
  "POST /api/expenses/:expense/split":       R<SplitInput, Ok, "expense_not_found" | "password_required" | "bad_split_type">;
  "POST /api/expenses/:expense/items":       R<NewItem, { id: string }, "expense_not_found" | "password_required" | "member_not_found">;
  "POST /api/expenses/:expense/photos":      R<Blob, { id: string }, "expense_not_found" | "password_required" | "not_image" | "empty" | "too_large">;
  "PATCH /api/items/:item":          R<ItemPatch, Ok, "item_not_found" | "password_required" | "member_not_found">;
  "DELETE /api/items/:item":         R<{}, Ok, "item_not_found" | "password_required">;
  "DELETE /api/photos/:photo":       R<{}, Ok, "photo_not_found" | "password_required">;
  "DELETE /api/settlements/:settlement": R<{}, Ok, "settlement_not_found" | "password_required">;

  "POST /api/journeys":              R<NewJourney, { token: string }, "no_trips" | "settle_currency_mismatch">;
  "GET /api/journeys/:journey":      R<{}, JourneyView, JourneyGate>;
  "DELETE /api/journeys/:journey":   R<{ name: string }, Ok, JourneyGate | "name_mismatch">;
  "POST /api/journeys/:journey/join":     R<{}, Ok, "journey_not_found">;
  "POST /api/journeys/:journey/trips":    R<{ trip_token: string }, Ok, JourneyGate | "trip_not_found" | "no_trip_access" | "already_in_journey" | "settle_currency_mismatch">;
  "DELETE /api/journeys/:journey/trips/:trip":     R<{}, Ok, JourneyGate>;
  "POST /api/journeys/:journey/merge":    R<{ member_ids: string[] }, Ok & { group_id: string }, JourneyGate | "need_two_members">;
  "DELETE /api/journeys/:journey/merge/:member":   R<{}, Ok, JourneyGate>;
  "PATCH /api/journeys/:journey/settings": R<JourneySettingsPatch, Ok, JourneyGate | "bad_name">;
}

type CallKey = keyof Routes;
type HrefKey = "GET /api/photos/:photo";

// Path params are entity-named (:trip, :expense…) so they can't collide
// with snake_case body keys; checked structurally below.
type PathParams<P> =
  P extends `${string}:${infer N}/${infer Rest}` ? { [k in N]: string } & PathParams<`/${Rest}`>
  : P extends `${string}:${infer N}` ? { [k in N]: string } : {};
type Params<K> = K extends `${string} ${infer P}` ? PathParams<P> : {};
type Body<K extends CallKey> = Routes[K] extends { body: infer B } ? B : never;
type Res<K extends CallKey> = Routes[K] extends { res: infer R } ? R : never;
type Codes<K extends CallKey> = Routes[K] extends { err: infer E } ? E : never;
type Input<K extends CallKey> = Params<K> & (Body<K> extends Blob ? { file: Blob } : Body<K>);

type Args<K extends CallKey, H> = {} extends Input<K> ? [input?: Input<K>, on?: H] : [input: Input<K>, on?: H];
type Handlers<K extends CallKey> = { [C in Codes<K> & string]?: (e: ApiError<C>) => unknown };
type Handled<H> = { [C in keyof H]: H[C] extends (...a: unknown[]) => infer T ? Awaited<T> : never }[keyof H];

// Compile-time: no route may reuse a path-param name as a body key.
type Clash = { [K in CallKey]: keyof Params<K> & keyof Body<K> extends never ? never : K }[CallKey];
const _noClash: [Clash] extends [never] ? true : Clash = true;

// ---------- transport ----------

export type Transport = {
  send(req: { method: string; path: string; json?: unknown; file?: Blob }): Promise<{ status: number; data: unknown }>;
  subscribe(tripToken: string, on: (ev: "message" | "reopen") => void): () => void;
  url(path: string): string;
};

export const browserTransport = (base: string): Transport => ({
  send: async ({ method, path, json, file }) => {
    try {
      const res = await fetch(base + path, {
        method,
        headers: {
          "x-wts": "1",
          ...(json !== undefined ? { "content-type": "application/json" } : {}),
          ...(file !== undefined ? { "content-type": file.type } : {}),
        },
        body: file ?? (json !== undefined ? JSON.stringify(json) : undefined),
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    } catch {
      return { status: 0, data: {} };
    }
  },
  subscribe: (tripToken, on) => {
    const es = new EventSource(base + `/api/trips/${tripToken}/events`);
    es.onmessage = () => on("message");
    // reopen = a stream that failed and reconnected; pings may have been
    // missed, so watchers treat it as a change. The initial open isn't a reopen.
    let seenError = false;
    es.onerror = () => { seenError = true; };
    es.onopen = () => { if (seenError) on("reopen"); };
    return () => es.close();
  },
  url: (path) => base + path,
});

// ---------- core ----------

export function createApi(t: Transport) {
  // Session bootstrap: the first request goes out alone so the session cookie
  // exists before any parallel requests mint their own (the old ?pw= race).
  let bootstrap: Promise<void> | null = null;
  // Read-your-writes: GETs wait for all in-flight writes so a read never sees
  // pre-mutation state.
  const inflightWrites = new Set<Promise<void>>();

  const sendWire = async (method: string, path: string, body?: unknown, file?: Blob) => {
    if (!bootstrap) {
      const p = t.send({ method, path, json: body, file });
      bootstrap = p.then(() => undefined, () => undefined);
      return p;
    }
    await bootstrap;
    return t.send({ method, path, json: body, file });
  };

  const paramRe = /:([A-Za-z_]+)/g;

  // Mutation echo: successful writes wake watchers (SSE covers other clients;
  // this covers our own in case the stream is lagging or closed).
  const listeners = new Set<() => void>();
  const subscriptions = new Map<string, { count: number; close: () => void }>();
  const echo = () => listeners.forEach((l) => l());

  const call = async <K extends CallKey, H extends Handlers<K> = {}>(
    route: K, ...rest: Args<K, H>
  ): Promise<Res<K> | Handled<H>> => {
    const [method, tpl] = route.split(" ", 2) as [string, string];
    const input = (rest[0] ?? {}) as Record<string, unknown>;
    const on = (rest[1] ?? {}) as Record<string, (e: ApiError) => unknown>;
    const body: Record<string, unknown> = {};
    let file: Blob | undefined;
    const path = tpl.replace(paramRe, (_m, name: string) => encodeURIComponent(String(input[name])));
    for (const [k, v] of Object.entries(input))
      if (!tpl.includes(`:${k}`)) body[k] = v;
    if ("file" in body) { file = body.file as Blob; delete body.file; }
    const isGet = method === "GET";
    if (isGet) await Promise.allSettled([...inflightWrites]);

    const doSend = async () => sendWire(method, path,
      file ? undefined : (isGet ? undefined : body), file);
    let r: { status: number; data: unknown };
    if (isGet) {
      r = await doSend();
    } else {
      const p = doSend();
      const w = p.then(() => undefined, () => undefined);
      inflightWrites.add(w);
      try { r = await p; } finally { inflightWrites.delete(w); }
    }
    const data = (r.data ?? {}) as Record<string, unknown>;
    if (r.status === 0) throw new ApiError(0, "network" as ErrorCode);
    if (r.status >= 400) {
      const code = String(data.error ?? `http_${r.status}`) as ErrorCode;
      const h = (on as Record<string, ((e: ApiError) => unknown) | undefined>)[code];
      if (h) return h(new ApiError(r.status, code, data)) as Handled<H>;
      throw new ApiError(r.status, code, data);
    }
    if (!isGet) echo();
    // Cast = wire contract: the Routes table declares the shape the server
    // produces for this key; nothing validates it at runtime.
    return data as Res<K>;
  };


  const watch = (tripTokens: string[], onChange: () => void): (() => void) => {
    const l = () => onChange();
    listeners.add(l);
    for (const tok of tripTokens) {
      const sub = subscriptions.get(tok) ?? { count: 0, close: () => {} };
      if (!sub.count) sub.close = t.subscribe(tok, l);
      sub.count++;
      subscriptions.set(tok, sub);
    }
    return () => {
      listeners.delete(l);
      for (const tok of tripTokens) {
        const sub = subscriptions.get(tok);
        if (!sub) continue;
        if (--sub.count === 0) { sub.close(); subscriptions.delete(tok); }
      }
    };
  };

  const href = <K extends HrefKey>(route: K, params: Params<K>): string => {
    const [, tpl] = route.split(" ", 2) as [string, string];
    const path = tpl.replace(paramRe, (_m, name: string) =>
      encodeURIComponent(String((params as Record<string, unknown>)[name])));
    return t.url(path);
  };

  return { call, watch, href };
}

export const api = createApi(browserTransport(BASE));
