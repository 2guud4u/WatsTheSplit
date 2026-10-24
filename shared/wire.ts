// Wire contract shared by server and client.
// The server's err() is typed against ErrorCode and routes build payloads that
// satisfy these views, so drift fails to compile on the producing side.
// Field names stay snake_case — the wire is snake_case end to end.

export type ErrorCode =
  // sign-in
  | "bad_email" | "too_many_codes" | "send_failed"
  | "no_code" | "code_expired" | "too_many_attempts" | "wrong_code"
  // access gates (access.ts) — 401 password_required, 403 no_access
  | "password_required" | "password_empty" | "wrong_password" | "no_access" | "no_trip_access"
  | "only_creator" | "member_linked" | "not_your_member" | "payer_only"
  | "payer_or_self_only" | "end_date_required"
  // validation
  | "name_required" | "bad_name" | "name_taken" | "name_mismatch"
  | "bad_currency" | "currencies_locked" | "bad_total" | "bad_payer"
  | "bad_members" | "bad_amount" | "bad_split_type" | "member_or_name_required"
  | "member_in_use" | "cannot_remove_self" | "need_two_members" | "no_trips"
  | "settle_currency_mismatch" | "already_in_journey"
  | "not_image" | "empty" | "too_large"
  // not found
  | "trip_not_found" | "expense_not_found" | "item_not_found" | "photo_not_found"
  | "member_not_found" | "settlement_not_found" | "journey_not_found" | "not_found"
  // protocol — emitted by handle() before routes run
  | "missing_header" | "bad_json";

export type Ok = { ok: true };

// ---------- session ----------

export type Config = { baseUrl: string; currencies: string[] };
export type Me = { user: { email: string; name: string | null } | null };
export type TripSummary = { token: string; name: string; trip_currency: string; settle_currency: string };
export type JourneySummary = { token: string; name: string; settle_currency: string };
export type AccessibleTrip = TripSummary & { journey: JourneySummary | null };
export type MyTrips = { trips: TripSummary[] };
export type MyJourneys = { journeys: JourneySummary[] };
export type MemberSuggestions = { suggestions: string[] };

// ---------- trip view ----------

export type Award = { emoji: string; title: string; members: string[]; detail: string };
export type FunBoard = { awards: Award[]; review?: TripReview };

// "Trip in Review": the Wrapped stats layer, in settle-currency units.
export type TripReview = {
  total: string;                 // formatted total spend
  expenseCount: number;
  currencies: string[];          // every currency expenses were recorded in
  biggest: { name: string; total: string } | null;    // biggest single expense
  biggestDay: { date: string; total: string } | null; // highest-spend day
  categories: { cat: string; units: number }[];       // spend per category, desc
  members: { name: string; consumed: string; covered: string; count: number }[];
  daily: { day: string; units: number }[];            // spend per day, asc
};

export type TripMember = {
  id: string; name: string; linked: boolean; used: boolean;
  is_me: boolean; opted_out_fun: boolean;
};
export type MeMember = { id: string; name: string; linked: boolean; opted_out_fun: boolean };

export type ExpenseSum = {
  id: string; name: string; currency: string; total_minor: number;
  payer_member_id: string | null; category: string | null;
  rate: number | null;
  unassigned_minor: number; over: boolean;
  paid_out: boolean; paid_count: number; share_count: number;
  photos?: string[];
};

export type SettlementRow = {
  id: string; from_member: string; to_member: string;
  amount_minor: number; created_at: string; created_by: string | null;
};

export type BalancePair = { from: string; to: string; amount: number };
export type BalanceLogEntry = {
  kind: "expense" | "settlement"; label: string;
  share_minor?: number; currency?: string; rate?: number | null;
  converted?: number; amount_minor?: number;
};

export type TripView = {
  trip: {
    token: string; name: string; start_date: string | null; end_date: string | null;
    created_at: string; trip_currency: string; settle_currency: string;
    has_password: boolean; password: string | null; fun_leaderboard: boolean;
  };
  me: MeMember | null;
  access: "edit" | "view";
  signed_in: boolean;
  is_creator: boolean;
  members: TripMember[];
  balances: BalancePair[];
  journey: { token: string; name: string } | null;
  balance_log: Record<string, BalanceLogEntry[]>;
  no_rate_count: number;
  unfinished_count: number;
  expenses: ExpenseSum[];
  settlements: SettlementRow[];
  fx_timestamp: string | null;
  current_rate: { rate: number; providerTimestamp: string | null } | null;
  fun: FunBoard | null;
};

// ---------- expense view ----------

export type ItemRow = { id: string; name: string; price_minor: number; sharers: string[] };
export type ParticipantRow = { member_id: string; share_minor: number | null; name: string; paid: number };
export type EffectiveShare = { member_id: string; minor: number | null };

export type ExpenseDetail = ExpenseSum & {
  rate_provider: string | null; rate_timestamp: string | null;
  recorded_at: string; last_edited_by: string | null; last_edited_at: string;
  assigned_minor: number;
  participants: ParticipantRow[];
  items: ItemRow[];
  effective_shares: EffectiveShare[];
  photos: string[];
};

export type ExpenseView = {
  expense: ExpenseDetail;
  trip: { token: string; name: string; settle_currency: string };
  access: "edit" | "view";
  members: { id: string; name: string }[];
  me: string | null;
};

// ---------- journey view ----------

export type JourneyTrip = {
  token: string; name: string; settle_currency: string;
  access: "edit" | "view";
  members: { id: string; name: string; linked: boolean; used: boolean; opted_out_fun: boolean }[];
  expenses: ExpenseSum[];
};
export type Person = { key: string; name: string; memberIds: string[]; linked: boolean };
export type JourneyMemberRow = {
  id: string; name: string; trip_name: string; key: string;
  linked: boolean; opted_out_fun: boolean;
};
export type MergeHint = { name: string; member_ids: string[]; trips: string[] };
export type TransferPart = {
  trip_token: string; trip_name: string; from_member: string; to_member: string;
  amount: number; against: boolean;
};
export type Transfer = {
  from: string; to: string; amount: number;
  from_key: string; to_key: string; parts: TransferPart[];
};

export type JourneyView = {
  journey: { token: string; name: string; settle_currency: string; fun_leaderboard: boolean };
  signed_in: boolean;
  wrapped_at: string | null;
  fun: FunBoard | null;
  trips: JourneyTrip[];
  persons: Person[];
  members: JourneyMemberRow[];
  mergeHints: MergeHint[];
  my_member_ids: string[];
  transfers: Transfer[];
  mergeableTrips: TripSummary[];
};

// ---------- inputs ----------

export type NewTrip = {
  name: string; password: string; trip_currency: string; settle_currency: string;
  start_date?: string | null; end_date?: string | null; members?: string[] | string;
};
export type TripSettingsPatch = {
  name?: string; start_date?: string | null; end_date?: string | null;
  fun_leaderboard?: boolean; password?: string;
};
export type ClaimInput = { member_id: string } | { name: string };
export type NewExpense = {
  name: string; total_minor: number; currency?: string; payer_member_id?: string | null;
  category?: string | null;
};
export type ExpensePatch = {
  name?: string; total_minor?: number; payer_member_id?: string | null;
  category?: string | null; paid_out?: boolean; currency?: string;
};
export type NewSettlement = { from_member: string; to_member: string; amount_minor: number };
export type ItemPatch = { name?: string; price_minor?: number; sharers?: string[] };
export type NewItem = { name?: string; price_minor?: number; sharers?: string[] };
export type SplitInput =
  | { type: "equal_rest"; member_ids?: string[] }
  | { type: "proportional" };
export type MemberPatch = { name?: string; opted_out_fun?: boolean };
export type NewJourney = { name: string; trip_tokens: string[] };
export type JourneySettingsPatch = { name?: string; fun_leaderboard?: boolean };
