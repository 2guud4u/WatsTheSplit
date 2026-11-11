import type {
  AccessibleTrip,
  Award,
  ClaimInput,
  Config,
  ErrorCode,
  ExpensePatch,
  ExpenseView,
  HistoryEntry,
  ItemPatch,
  JourneySettingsPatch,
  JourneyView,
  Me,
  MemberPatch,
  MemberSuggestions,
  MyJourneys,
  MyTrips,
  NewExpense,
  NewItem,
  NewJourney,
  NewSettlement,
  NewTrip,
  Ok,
  PaymentMethod,
  SplitInput,
  TripSettingsPatch,
  TripView,
} from "../../shared/wire.ts"
import type { ApiError } from "./transport.ts"

// ---------- route table (type-only; zero runtime bytes) ----------

type R<Body, Res, Err extends string = never> = { body: Body; res: Res; err: Err }
type TripGate = "trip_not_found" | "password_required"
type JourneyGate = "journey_not_found" | "no_access"

interface Routes {
  "GET /api/config": R<{}, Config>
  "GET /api/me": R<{}, Me>
  "PUT /api/me": R<{ payment?: PaymentMethod }, Me, "not_signed_in">
  "POST /api/auth/email": R<{ email: string }, Ok, "bad_email" | "too_many_codes" | "send_failed">
  "POST /api/auth/email/verify": R<
    { email: string; code: string },
    Ok,
    "no_code" | "code_expired" | "too_many_attempts" | "wrong_code"
  >
  "POST /api/auth/signout": R<{}, Ok>
  "GET /api/my-trips": R<{}, MyTrips>
  "GET /api/my-journeys": R<{}, MyJourneys>
  "GET /api/accessible-trips": R<{}, { trips: AccessibleTrip[] }>
  "GET /api/member-suggestions": R<{}, MemberSuggestions>

  "POST /api/trips": R<NewTrip, { token: string; url: string }, "name_required" | "bad_currency" | "password_required">
  "GET /api/trips/:trip": R<{}, TripView, TripGate>
  "GET /api/trips/:trip/history": R<{}, { history: HistoryEntry[] }, TripGate>
  "DELETE /api/trips/:trip": R<{ name: string }, Ok, TripGate | "name_mismatch">
  "POST /api/trips/:trip/password": R<{ password: string }, Ok, "trip_not_found" | "wrong_password">
  "PATCH /api/trips/:trip/settings": R<
    TripSettingsPatch,
    Ok,
    TripGate | "currencies_locked" | "only_creator" | "password_empty" | "end_date_required"
  >
  "POST /api/trips/:trip/claim": R<
    ClaimInput,
    { ok: true; member_id: string },
    TripGate | "member_not_found" | "member_linked" | "name_taken" | "member_or_name_required"
  >
  "POST /api/trips/:trip/members": R<{ name: string }, { id: string }, TripGate | "name_required" | "name_taken">
  "POST /api/trips/:trip/detail-view": R<{}, Ok, TripGate>
  "POST /api/trips/:trip/expenses": R<
    NewExpense,
    { id: string },
    TripGate | "name_required" | "bad_currency" | "bad_total" | "bad_payer"
  >
  "POST /api/trips/:trip/settlements": R<NewSettlement, { id: string }, TripGate | "bad_members" | "bad_amount">

  "PATCH /api/members/:member": R<
    MemberPatch,
    Ok,
    TripGate | "member_not_found" | "name_required" | "name_taken" | "not_your_member"
  >
  "DELETE /api/members/:member": R<{}, Ok, TripGate | "member_not_found" | "member_in_use" | "cannot_remove_self">

  "GET /api/expenses/:expense": R<{}, ExpenseView, "expense_not_found" | "password_required">
  "PATCH /api/expenses/:expense": R<
    ExpensePatch,
    Ok,
    "expense_not_found" | "password_required" | "bad_total" | "bad_payer" | "payer_only" | "bad_currency"
  >
  "DELETE /api/expenses/:expense": R<{}, Ok, "expense_not_found" | "password_required">
  "PUT /api/expenses/:expense/paid": R<
    { member_id: string; paid: boolean },
    Ok,
    "expense_not_found" | "password_required" | "member_not_found" | "payer_or_self_only"
  >
  "PUT /api/expenses/:expense/participants": R<
    { member_id: string; on: boolean },
    Ok,
    "expense_not_found" | "password_required" | "member_not_found"
  >
  "PUT /api/expenses/:expense/shares": R<
    { member_id: string; share_minor: number | null },
    Ok,
    "expense_not_found" | "password_required" | "member_not_found"
  >
  "POST /api/expenses/:expense/split": R<SplitInput, Ok, "expense_not_found" | "password_required" | "bad_split_type">
  "POST /api/expenses/:expense/items": R<
    NewItem,
    { id: string },
    "expense_not_found" | "password_required" | "member_not_found"
  >
  "POST /api/expenses/:expense/photos": R<
    Blob,
    { id: string },
    "expense_not_found" | "password_required" | "not_image" | "empty" | "too_large"
  >
  "PATCH /api/items/:item": R<ItemPatch, Ok, "item_not_found" | "password_required" | "member_not_found">
  "DELETE /api/items/:item": R<{}, Ok, "item_not_found" | "password_required">
  "DELETE /api/photos/:photo": R<{}, Ok, "photo_not_found" | "password_required">
  "DELETE /api/settlements/:settlement": R<{}, Ok, "settlement_not_found" | "password_required">

  "POST /api/journeys": R<NewJourney, { token: string }, "no_trips" | "settle_currency_mismatch">
  "GET /api/journeys/:journey": R<{}, JourneyView, JourneyGate>
  "DELETE /api/journeys/:journey": R<{ name: string }, Ok, JourneyGate | "name_mismatch">
  "POST /api/journeys/:journey/join": R<{}, Ok, "journey_not_found">
  "POST /api/journeys/:journey/trips": R<
    { trip_token: string },
    Ok,
    JourneyGate | "trip_not_found" | "no_trip_access" | "already_in_journey" | "settle_currency_mismatch"
  >
  "DELETE /api/journeys/:journey/trips/:trip": R<{}, Ok, JourneyGate>
  "POST /api/journeys/:journey/merge": R<
    { member_ids: string[] },
    Ok & { group_id: string },
    JourneyGate | "need_two_members"
  >
  "DELETE /api/journeys/:journey/merge/:member": R<{}, Ok, JourneyGate>
  "PATCH /api/journeys/:journey/settings": R<JourneySettingsPatch, Ok, JourneyGate | "bad_name" | "end_date_required">
}

type CallKey = keyof Routes
type HrefKey = "GET /api/photos/:photo"

// Path params are entity-named (:trip, :expense…) so they can't collide
// with snake_case body keys; checked structurally below.
type PathParams<P> = P extends `${string}:${infer N}/${infer Rest}`
  ? { [k in N]: string } & PathParams<`/${Rest}`>
  : P extends `${string}:${infer N}`
    ? { [k in N]: string }
    : {}
type Params<K> = K extends `${string} ${infer P}` ? PathParams<P> : {}
type Body<K extends CallKey> = Routes[K] extends { body: infer B } ? B : never
type Res<K extends CallKey> = Routes[K] extends { res: infer R } ? R : never
type Codes<K extends CallKey> = Routes[K] extends { err: infer E } ? E : never
type Input<K extends CallKey> = Params<K> & (Body<K> extends Blob ? { file: Blob } : Body<K>)

type Args<K extends CallKey, H> = {} extends Input<K> ? [input?: Input<K>, on?: H] : [input: Input<K>, on?: H]
type Handlers<K extends CallKey> = { [C in Codes<K> & string]?: (e: ApiError<C>) => unknown }
type Handled<H> = { [C in keyof H]: H[C] extends (...a: unknown[]) => infer T ? Awaited<T> : never }[keyof H]

// Compile-time: no route may reuse a path-param name as a body key.
type Clash = { [K in CallKey]: keyof Params<K> & keyof Body<K> extends never ? never : K }[CallKey]
const _noClash: [Clash] extends [never] ? true : Clash = true

export type { Args, CallKey, Handled, Handlers, HrefKey, Params, Res }
