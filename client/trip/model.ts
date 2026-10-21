import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { TripView, TripSettingsPatch, ClaimInput, NewExpense, NewSettlement } from "../api.ts";
import { addRecent } from "../types.ts";
import { useTripEvents } from "../hooks.ts";

// Trip screen model: owns the TripView fetch (incl. the password gate and the
// ?pw= share-link probe), live-reload wiring, and every mutation the view can
// trigger. The view renders `data` and calls `actions.*` — it never touches
// the api directly.
export function useTrip(token: string) {
  const [data, setData] = useState<TripView | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);

  const load = useCallback(async () => {
    const d = await api.call("GET /api/trips/:trip", { trip: token }, { password_required: () => "locked" as const })
      .catch(() => null);
    if (d === "locked") { setNeedsPassword(true); return; }
    if (!d) return;
    setData(d);
    setNeedsPassword(false);
    addRecent(token, d.trip.name);
  }, [token]);

  useEffect(() => {
    (async () => {
      // Share links carry ?pw= in the hash (never sent to the server). POST it
      // BEFORE the first load: both would otherwise race to create separate
      // anonymous sessions and consent could land on the losing cookie.
      const m = /\?pw=([^&]*)/.exec(location.hash);
      if (m) {
        const pw = decodeURIComponent(m[1]);
        history.replaceState(null, "", location.pathname + location.search + location.hash.replace(/\?pw=[^&]*/, ""));
        await api.call("POST /api/trips/:trip/password", { trip: token, password: pw }).catch(() => {});
      }
      load();
    })();
    const onFocus = () => load();
    addEventListener("focus", onFocus);
    return () => { removeEventListener("focus", onFocus); };
  }, [token]);
  useTripEvents([token], load);

  const actions = {
    // Password form: "bad" → show wrong-password error; "ok" → unlock + reload.
    unlock: async (password: string): Promise<"ok" | "bad"> => {
      const r = await api.call("POST /api/trips/:trip/password", { trip: token, password }, { wrong_password: () => "bad" as const })
        .catch(() => "bad" as const);
      if (r === "bad") return "bad";
      setNeedsPassword(false);
      load();
      return "ok";
    },
    claim: async (input: ClaimInput) => {
      await api.call("POST /api/trips/:trip/claim", { trip: token, ...input });
      load();
    },
    optOutFun: async (memberId: string) => {
      await api.call("PATCH /api/members/:member", { member: memberId, opted_out_fun: true });
      load();
    },
    detailView: () => { api.call("POST /api/trips/:trip/detail-view", { trip: token }).catch(() => {}); },
    createExpense: async (input: NewExpense) => {
      return api.call("POST /api/trips/:trip/expenses", { trip: token, ...input });
    },
    settle: async (input: NewSettlement) => {
      await api.call("POST /api/trips/:trip/settlements", { trip: token, ...input });
      load();
    },
    // No explicit reload: the watch echo refreshes (parity with old code).
    deleteSettlement: (id: string) => api.call("DELETE /api/settlements/:settlement", { settlement: id }),
    patchSettings: async (patch: TripSettingsPatch) => {
      await api.call("PATCH /api/trips/:trip/settings", { trip: token, ...patch });
      load();
    },
    addMember: async (name: string) => {
      await api.call("POST /api/trips/:trip/members", { trip: token, name });
      load();
    },
    removeMember: async (memberId: string) => {
      await api.call("DELETE /api/members/:member", { member: memberId });
      load();
    },
    deleteTrip: async (name: string) => {
      await api.call("DELETE /api/trips/:trip", { trip: token, name });
    },
  };

  return { data, needsPassword, load, actions };
}

export interface TripModel {
  data: TripView | null;
  needsPassword: boolean;
  load: () => Promise<void>;
  actions: {
    unlock: (password: string) => Promise<"ok" | "bad">;
    claim: (input: ClaimInput) => Promise<void>;
    optOutFun: (memberId: string) => Promise<void>;
    detailView: () => void;
    createExpense: (input: NewExpense) => Promise<{ id: string }>;
    settle: (input: NewSettlement) => Promise<void>;
    deleteSettlement: (id: string) => Promise<unknown>;
    patchSettings: (patch: TripSettingsPatch) => Promise<void>;
    addMember: (name: string) => Promise<void>;
    removeMember: (memberId: string) => Promise<void>;
    deleteTrip: (name: string) => Promise<void>;
  };
}
