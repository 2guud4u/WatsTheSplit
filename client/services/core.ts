import type { ErrorCode } from "../../shared/wire.ts"
import type { Args, CallKey, Handled, Handlers, HrefKey, Params, Res } from "./routes.ts"
import { ApiError, BASE, browserTransport, type Transport } from "./transport.ts"

export function createApi(t: Transport) {
  // Session bootstrap: the first request goes out alone so the session cookie
  // exists before any parallel requests mint their own (the old ?pw= race).
  let bootstrap: Promise<void> | null = null
  // Read-your-writes: GETs wait for all in-flight writes so a read never sees
  // pre-mutation state.
  const inflightWrites = new Set<Promise<void>>()

  const sendWire = async (method: string, path: string, body?: unknown, file?: Blob) => {
    if (!bootstrap) {
      const p = t.send({ method, path, json: body, file })
      bootstrap = p.then(
        () => undefined,
        () => undefined
      )
      return p
    }
    await bootstrap
    return t.send({ method, path, json: body, file })
  }

  const paramRe = /:([A-Za-z_]+)/g

  // Mutation echo: successful writes wake watchers (SSE covers other clients;
  // this covers our own in case the stream is lagging or closed).
  const listeners = new Set<() => void>()
  const subscriptions = new Map<string, { count: number; close: () => void }>()
  const echo = () => {
    for (const l of listeners) l()
  }

  const call = async <K extends CallKey, H extends Handlers<K> = {}>(
    route: K,
    ...rest: Args<K, H>
  ): Promise<Res<K> | Handled<H>> => {
    const [method, tpl] = route.split(" ", 2) as [string, string]
    const input = (rest[0] ?? {}) as Record<string, unknown>
    const on = (rest[1] ?? {}) as Record<string, (e: ApiError) => unknown>
    const body: Record<string, unknown> = {}
    let file: Blob | undefined
    const path = tpl.replace(paramRe, (_m, name: string) => encodeURIComponent(String(input[name])))
    for (const [k, v] of Object.entries(input)) if (!tpl.includes(`:${k}`)) body[k] = v
    if ("file" in body) {
      file = body.file as Blob
      delete body.file
    }
    const isGet = method === "GET"
    if (isGet) await Promise.allSettled([...inflightWrites])

    const doSend = async () => sendWire(method, path, file ? undefined : isGet ? undefined : body, file)
    let r: { status: number; data: unknown }
    if (isGet) {
      r = await doSend()
    } else {
      const p = doSend()
      const w = p.then(
        () => undefined,
        () => undefined
      )
      inflightWrites.add(w)
      try {
        r = await p
      } finally {
        inflightWrites.delete(w)
      }
    }
    const data = (r.data ?? {}) as Record<string, unknown>
    if (r.status === 0) throw new ApiError(0, "network" as ErrorCode)
    if (r.status >= 400) {
      const code = String(data.error ?? `http_${r.status}`) as ErrorCode
      const h = (on as Record<string, ((e: ApiError) => unknown) | undefined>)[code]
      if (h) return h(new ApiError(r.status, code, data)) as Handled<H>
      throw new ApiError(r.status, code, data)
    }
    if (!isGet) echo()
    // Cast = wire contract: the Routes table declares the shape the server
    // produces for this key; nothing validates it at runtime.
    return data as Res<K>
  }

  const watch = (tripTokens: string[], onChange: () => void): (() => void) => {
    const l = () => onChange()
    listeners.add(l)
    for (const tok of tripTokens) {
      const sub = subscriptions.get(tok) ?? { count: 0, close: () => {} }
      if (!sub.count) sub.close = t.subscribe(tok, l)
      sub.count++
      subscriptions.set(tok, sub)
    }
    return () => {
      listeners.delete(l)
      for (const tok of tripTokens) {
        const sub = subscriptions.get(tok)
        if (!sub) continue
        if (--sub.count === 0) {
          sub.close()
          subscriptions.delete(tok)
        }
      }
    }
  }

  const href = <K extends HrefKey>(route: K, params: Params<K>): string => {
    const [, tpl] = route.split(" ", 2) as [string, string]
    const path = tpl.replace(paramRe, (_m, name: string) =>
      encodeURIComponent(String((params as Record<string, unknown>)[name]))
    )
    return t.url(path)
  }

  return { call, watch, href }
}

export const api = createApi(browserTransport(BASE))
