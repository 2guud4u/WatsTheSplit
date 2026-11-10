// The api module: split into transport (errors + the wire transport + BASE),
// routes (the type-only route table), and core (createApi / api). Re-export
// everything here so callers keep importing from "../services/api.ts" — no
// consumer change, same public surface as before.
export type * from "../../shared/wire.ts";
export {
  ApiError, isApiError, describeError, BASE,
  browserTransport, type Transport,
} from "./transport.ts";
export {
  type CallKey, type HrefKey, type Params, type Res, type Args,
  type Handlers, type Handled,
} from "./routes.ts";
export { createApi, api } from "./core.ts";
