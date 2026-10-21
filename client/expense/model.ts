import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { ExpenseView, ExpensePatch, ItemPatch, NewItem, SplitInput } from "../api.ts";
import { useTripEvents } from "../hooks.ts";

// Expense screen model: fetches the ExpenseView, live-reloads off the trip's
// event stream, and wraps every mutation the view can trigger. A failed fetch
// means the expense is gone — the model bounces back to the trip, same as the
// old view did.
export function useExpense(token: string, expenseId: string) {
  const [data, setData] = useState<ExpenseView | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.call("GET /api/expenses/:expense", { expense: expenseId })); }
    catch { location.hash = `#/t/${token}`; }
  }, [expenseId, token]);

  useEffect(() => { load(); }, [load]);
  useTripEvents([token], load);

  const id = expenseId;
  const actions = {
    patch: (b: ExpensePatch) => api.call("PATCH /api/expenses/:expense", { expense: id, ...b }).then(load),
    setParticipant: async (memberId: string, on: boolean) => {
      await api.call("PUT /api/expenses/:expense/participants", { expense: id, member_id: memberId, on });
      load();
    },
    setShare: async (memberId: string, shareMinor: number | null) => {
      await api.call("PUT /api/expenses/:expense/shares", { expense: id, member_id: memberId, share_minor: shareMinor });
      load();
    },
    setPaid: async (memberId: string, paid: boolean) => {
      await api.call("PUT /api/expenses/:expense/paid", { expense: id, member_id: memberId, paid });
      load();
    },
    split: async (input: SplitInput) => {
      await api.call("POST /api/expenses/:expense/split", { expense: id, ...input });
      load();
    },
    patchItem: async (itemId: string, patch: ItemPatch) => {
      await api.call("PATCH /api/items/:item", { item: itemId, ...patch });
      load();
    },
    deleteItem: async (itemId: string) => {
      await api.call("DELETE /api/items/:item", { item: itemId });
      load();
    },
    addItem: async (input: NewItem) => {
      await api.call("POST /api/expenses/:expense/items", { expense: id, ...input });
      load();
    },
    addPhoto: async (file: Blob) => {
      await api.call("POST /api/expenses/:expense/photos", { expense: id, file });
      load();
    },
    deletePhoto: async (photoId: string) => {
      await api.call("DELETE /api/photos/:photo", { photo: photoId });
      load();
    },
    destroy: () => api.call("DELETE /api/expenses/:expense", { expense: id }),
  };

  return { data, load, actions };
}

export interface ExpenseModel {
  data: ExpenseView | null;
  load: () => Promise<void>;
  actions: {
    patch: (b: ExpensePatch) => Promise<unknown>;
    setParticipant: (memberId: string, on: boolean) => Promise<void>;
    setShare: (memberId: string, shareMinor: number | null) => Promise<void>;
    setPaid: (memberId: string, paid: boolean) => Promise<void>;
    split: (input: SplitInput) => Promise<void>;
    patchItem: (itemId: string, patch: ItemPatch) => Promise<void>;
    deleteItem: (itemId: string) => Promise<void>;
    addItem: (input: NewItem) => Promise<void>;
    addPhoto: (file: Blob) => Promise<void>;
    deletePhoto: (photoId: string) => Promise<void>;
    destroy: () => Promise<unknown>;
  };
}
