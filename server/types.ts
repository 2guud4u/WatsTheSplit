export type Session = { token: string; user_sub: string | null };
export type Member = {
  id: string; trip_token: string; name: string; user_sub: string | null; opted_out_fun?: number; detail_views?: number;
};
export type Trip = {
  token: string; name: string; start_date: string | null; end_date: string | null;
  trip_currency: string; settle_currency: string; password_hash: string | null;
  password_text: string | null;
  created_at: string;
  password_ver: number; fun_leaderboard: number; created_by_token: string | null;
};
export type Journey = { token: string; name: string; settle_currency: string; created_at: string; fun_leaderboard?: number };
export type ExpenseRow = {
  id: string; trip_token: string; name: string; currency: string;
  total_minor: number; payer_member_id: string | null; category: string | null;
  rate: number | null; rate_provider: string | null; rate_timestamp: string | null;
  recorded_at: string; last_edited_by: string | null; last_edited_at: string;
  created_by_member_id?: string | null;
  paid_out: number;
};
