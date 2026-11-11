// The api module: split into transport (errors + the wire transport + BASE),
// routes (the type-only route table), and core (createApi / api). Re-export
// everything here so callers keep importing from "../services/api.ts" — no
// consumer change, same public surface as before.
export type * from "../../shared/wire.ts"
export { api, createApi } from "./core.ts"
export type { Args, CallKey, Handled, Handlers, HrefKey, Params, Res } from "./routes.ts"
export {
  ApiError,
  BASE,
  browserTransport,
  describeError,
  isApiError,
  type Transport,
} from "./transport.ts"
