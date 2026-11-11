import { addRecent } from "../utils/types.ts"
import type { AccessibleTrip, JourneySummary, NewJourney, NewTrip, TripSummary } from "./api.ts"
import { api } from "./api.ts"

// Home screen model: the create-trip / create-journey / sign-out calls plus the
// suggestion + my-trips fetches the view's panels need. Fetch errors surface as
// thrown promises — the view catches into its `err` box exactly where the old
// inline code did.
export const homeActions = {
  accessibleTrips: () => api.call("GET /api/accessible-trips", {}),
  memberSuggestions: () => api.call("GET /api/member-suggestions", {}),
  myJourneys: () => api.call("GET /api/my-journeys", {}),
  myTrips: () => api.call("GET /api/my-trips", {}),
  createTrip: async (input: NewTrip) => {
    const r = await api.call("POST /api/trips", input)
    addRecent(r.token, input.name)
    return r
  },
  createJourney: (input: NewJourney) => api.call("POST /api/journeys", input),
  signOut: () => api.call("POST /api/auth/signout", {}),
}

export type { AccessibleTrip, JourneySummary, TripSummary }
