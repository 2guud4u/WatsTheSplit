import { useCallback, useEffect, useState } from "react"
import type { ExpensePatch, ExpenseView, ItemPatch, NewItem, SplitInput } from "../services/api.ts"
import { api } from "../services/api.ts"
import { useTripEvents } from "./useTripEvents.ts"

// Expense screen model: fetches the ExpenseView, live-reloads off the trip's
// event stream, and wraps every mutation the view can trigger. A failed fetch
// means the expense is gone — the model bounces back to the trip, same as the
// old view did. When the expense is opened from a journey (journeyToken set),
// the fallback bounces back to that journey instead.
export function useExpense(token: string, expenseId: string, journeyToken: string | null = null) {
  const [data, setData] = useState<ExpenseView | null>(null)
  const fallbackHash = journeyToken ? `#/j/${journeyToken}` : `#/t/${token}`

  const load = useCallback(async () => {
    try {
      setData(await api.call("GET /api/expenses/:expense", { expense: expenseId }))
    } catch {
      location.hash = fallbackHash
    }
  }, [expenseId, fallbackHash])

  useEffect(() => {
    void load()
  }, [load])
  useTripEvents([token], load)

  const id = expenseId
  const actions = {
    patch: (b: ExpensePatch) =>
      api
        .call("PATCH /api/expenses/:expense", { expense: id, ...b })
        .then(load)
        .catch(() => {}),
    setParticipant: async (memberId: string, on: boolean) => {
      await api.call("PUT /api/expenses/:expense/participants", { expense: id, member_id: memberId, on })
      void load()
    },
    setShare: async (memberId: string, shareMinor: number | null) => {
      await api.call("PUT /api/expenses/:expense/shares", { expense: id, member_id: memberId, share_minor: shareMinor })
      void load()
    },
    setPaid: async (memberId: string, paid: boolean) => {
      await api.call("PUT /api/expenses/:expense/paid", { expense: id, member_id: memberId, paid })
      void load()
    },
    split: async (input: SplitInput) => {
      await api.call("POST /api/expenses/:expense/split", { expense: id, ...input })
      void load()
    },
    patchItem: async (itemId: string, patch: ItemPatch) => {
      await api.call("PATCH /api/items/:item", { item: itemId, ...patch })
      void load()
    },
    deleteItem: async (itemId: string) => {
      await api.call("DELETE /api/items/:item", { item: itemId })
      void load()
    },
    addItem: async (input: NewItem) => {
      await api.call("POST /api/expenses/:expense/items", { expense: id, ...input })
      void load()
    },
    addPhoto: async (file: Blob) => {
      await api.call("POST /api/expenses/:expense/photos", { expense: id, file })
      void load()
    },
    deletePhoto: async (photoId: string) => {
      await api.call("DELETE /api/photos/:photo", { photo: photoId })
      void load()
    },
    destroy: () => api.call("DELETE /api/expenses/:expense", { expense: id }),
  }

  return { data, load, actions }
}

export interface ExpenseModel {
  data: ExpenseView | null
  load: () => Promise<void>
  actions: {
    patch: (b: ExpensePatch) => Promise<unknown>
    setParticipant: (memberId: string, on: boolean) => Promise<void>
    setShare: (memberId: string, shareMinor: number | null) => Promise<void>
    setPaid: (memberId: string, paid: boolean) => Promise<void>
    split: (input: SplitInput) => Promise<void>
    patchItem: (itemId: string, patch: ItemPatch) => Promise<void>
    deleteItem: (itemId: string) => Promise<void>
    addItem: (input: NewItem) => Promise<void>
    addPhoto: (file: Blob) => Promise<void>
    deletePhoto: (photoId: string) => Promise<void>
    destroy: () => Promise<unknown>
  }
}
