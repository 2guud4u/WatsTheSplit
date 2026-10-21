import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { JourneyView, JourneySettingsPatch, TransferPart } from "../api.ts";
import { useTripEvents } from "../hooks.ts";

// Journey screen model: fetches the JourneyView, live-reloads off every member
// trip's event stream, and wraps every mutation the view can trigger. `err`
// carries both the fetch error (e.g. "no_access" → the join gate) and merge
// failures, same as the old view.
export function useJourney(token: string) {
  const [data, setData] = useState<JourneyView | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try { setData(await api.call("GET /api/journeys/:journey", { journey: token })); setErr(""); }
    catch (e) { setErr(e instanceof Error ? e.message : "error"); }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  // live-refresh off every member trip's event stream
  useTripEvents(data?.trips.map((t) => t.token) ?? null, load);

  const actions = {
    join: async () => {
      await api.call("POST /api/journeys/:journey/join", { journey: token });
      load();
    },
    merge: async (memberIds: string[]) => {
      try { await api.call("POST /api/journeys/:journey/merge", { journey: token, member_ids: memberIds }); load(); }
      catch (e) { setErr(e instanceof Error ? e.message : "error"); }
    },
    unmerge: async (memberId: string) => {
      await api.call("DELETE /api/journeys/:journey/merge/:member", { journey: token, member: memberId }); load();
    },
    removeTrip: async (tripToken: string) => {
      await api.call("DELETE /api/journeys/:journey/trips/:trip", { journey: token, trip: tripToken }); load();
    },
    addTrip: async (tripToken: string) => {
      await api.call("POST /api/journeys/:journey/trips", { journey: token, trip_token: tripToken }); load();
    },
    claim: async (tripToken: string, memberId: string) => {
      await api.call("POST /api/trips/:trip/claim", { trip: tripToken, member_id: memberId }); load();
    },
    // Throws on name_taken — the view alerts. (Parity: the old call site did.)
    claimByName: async (tripToken: string, name: string) => {
      await api.call("POST /api/trips/:trip/claim", { trip: tripToken, name }); load();
    },
    // One click hides the viewer everywhere: every claimed member.
    optOutFunAll: async (memberIds: string[]) => {
      for (const id of memberIds)
        await api.call("PATCH /api/members/:member", { member: id, opted_out_fun: true });
      load();
    },
    // Record one Settlement in the part's own trip, in its own direction.
    settlePart: (p: TransferPart, minor: number) =>
      api.call("POST /api/trips/:trip/settlements", {
        trip: p.trip_token, from_member: p.from_member, to_member: p.to_member, amount_minor: minor,
      }),
    patchSettings: async (patch: JourneySettingsPatch) => {
      await api.call("PATCH /api/journeys/:journey/settings", { journey: token, ...patch });
      load();
    },
    dissolve: (name: string) => api.call("DELETE /api/journeys/:journey", { journey: token, name }),
  };

  return { data, err, load, actions };
}

export interface JourneyModel {
  data: JourneyView | null;
  err: string;
  load: () => Promise<void>;
  actions: {
    join: () => Promise<void>;
    merge: (memberIds: string[]) => Promise<void>;
    unmerge: (memberId: string) => Promise<void>;
    removeTrip: (tripToken: string) => Promise<void>;
    addTrip: (tripToken: string) => Promise<void>;
    claim: (tripToken: string, memberId: string) => Promise<void>;
    claimByName: (tripToken: string, name: string) => Promise<void>;
    optOutFunAll: (memberIds: string[]) => Promise<void>;
    settlePart: (p: TransferPart, minor: number) => Promise<unknown>;
    patchSettings: (patch: JourneySettingsPatch) => Promise<void>;
    dissolve: (name: string) => Promise<unknown>;
  };
}
