export type RegistryName = "crossref" | "openalex" | "datacite"

export type StubReply =
  | { readonly status: number; readonly body?: unknown }
  | { readonly error: Error }

export type DoiRoute = Partial<Record<RegistryName, StubReply>>

export interface FetchStub {
  readonly calls: string[]
  restore(): void
}

export function stubFetch(routes: Readonly<Record<string, DoiRoute>>): FetchStub {
  const original = globalThis.fetch
  const calls: string[] = []

  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push(url)

    const registry: RegistryName = url.includes("crossref")
      ? "crossref"
      : url.includes("openalex")
        ? "openalex"
        : "datacite"
    const route = Object.entries(routes).find(([doi]) => url.includes(encodeURIComponent(doi)))
    if (route === undefined) throw new Error(`Unexpected DOI request: ${url}`)

    const reply = route[1][registry] ?? { status: 404 }
    if ("error" in reply) throw reply.error

    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    })
  }

  return {
    calls,
    restore(): void {
      globalThis.fetch = original
    },
  }
}
