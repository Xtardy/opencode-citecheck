/**
 * Remote verification of DOIs.
 *
 * Order matters: Crossref first (it carries retraction data via `updated-by`),
 * then OpenAlex (broad coverage, fast), then DataCite (datasets, software,
 * Zenodo). A DOI that resolves in none of them does not exist.
 *
 * Every call is bounded by a timeout and every result is cached, because this
 * runs inside a hook that blocks the agent loop.
 */

import type { BibEntry } from "./bib.js"
import { entryDoi } from "./bib.js"

export type VerifyStatus =
  | "ok"
  | "retracted"
  | "unresolved"
  | "title-mismatch"
  | "no-doi"
  | "error"
  /** Not attempted (offline mode). Never a finding, only a "not verified" count. */
  | "skipped"

export interface VerifyResult {
  status: VerifyStatus
  /** Human-readable explanation, safe to show to the model. */
  detail?: string
  /** Where the record was found. */
  source?: "crossref" | "openalex" | "datacite"
  /** Title as reported by the registry. */
  title?: string
  /** Retraction notice DOIs, when the record was retracted. */
  retractionDois?: string[]
}

export interface VerifyOptions {
  /** Per-request timeout in ms. Default 8000. */
  timeoutMs?: number
  /** Max concurrent outbound requests. Default 6. */
  concurrency?: number
  /** Cache TTL in ms. Default 6h. */
  cacheTtlMs?: number
  /** Contact address for the Crossref/OpenAlex polite pool. */
  mailto?: string
  /** Disable all network access (used by tests and `--offline`). */
  offline?: boolean
}

const DEFAULT_TIMEOUT = 8_000
const DEFAULT_TTL = 6 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  at: number
  value: T
}

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>()
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  get(key: string): T | undefined {
    const hit = this.store.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at > this.ttlMs) {
      this.store.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: string, value: T): void {
    this.store.set(key, { at: Date.now(), value })
  }

  clear(): void {
    this.store.clear()
  }

  get size(): number {
    return this.store.size
  }
}

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

/**
 * Run `fn` over `items` with at most `limit` in flight.
 * Order of results matches the order of `items`.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T)
    }
  })

  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

/**
 * Loose title comparison. Deliberately forgiving: we want to catch
 * "this DOI points at a completely different paper", not to fail on
 * punctuation, capitalisation, HTML entities or a subtitle.
 */
export function titlesMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/g, " ")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim()

  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return true

  if (x === y) return true

  // Compare the first 8 words: enough to identify a paper, tolerant of a
  // truncated subtitle or a trailing "…".
  const head = (s: string) => s.split(" ").slice(0, 8).join(" ")
  if (head(x) === head(y)) return true

  // Token containment catches "Paper: a subtitle" vs "Paper".
  const shorter = x.length < y.length ? x : y
  const longer = x.length < y.length ? y : x
  return shorter.length >= 20 && longer.includes(shorter)
}

// ---------------------------------------------------------------------------
// registry clients
// ---------------------------------------------------------------------------

interface RegistryHit {
  title: string
  retracted: boolean
  retractionDois: string[]
}

class RegistryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function getJson(
  url: string,
  opts: Required<Pick<VerifyOptions, "timeoutMs">> & { mailto?: string },
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": opts.mailto
      ? `opencode-citecheck/0.1 (mailto:${opts.mailto})`
      : "opencode-citecheck/0.1",
  }

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs),
  })

  if (!res.ok) throw new RegistryError(`HTTP ${res.status}`, res.status)
  return res.json()
}

async function fromCrossref(doi: string, opts: Parameters<typeof getJson>[1]): Promise<RegistryHit> {
  const data = (await getJson(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    opts,
  )) as { message?: Record<string, unknown> }

  const message = data.message ?? {}
  const titles = message.title as string[] | undefined
  const updatedBy = (message["updated-by"] as Array<Record<string, unknown>> | undefined) ?? []

  const retractionDois = updatedBy
    .filter((u) => u.type === "retraction")
    .map((u) => String(u.DOI ?? ""))
    .filter(Boolean)

  return {
    title: titles?.[0] ?? "",
    retracted: retractionDois.length > 0,
    retractionDois,
  }
}

async function fromOpenAlex(doi: string, opts: Parameters<typeof getJson>[1]): Promise<RegistryHit> {
  const data = (await getJson(
    `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=title,publication_year`,
    opts,
  )) as { title?: string }

  return { title: data.title ?? "", retracted: false, retractionDois: [] }
}

async function fromDataCite(doi: string, opts: Parameters<typeof getJson>[1]): Promise<RegistryHit> {
  const data = (await getJson(
    `https://api.datacite.org/dois/${encodeURIComponent(doi)}`,
    opts,
  )) as { data?: { attributes?: { titles?: Array<{ title?: string }> } } }

  return {
    title: data.data?.attributes?.titles?.[0]?.title ?? "",
    retracted: false,
    retractionDois: [],
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export class Verifier {
  private readonly cache: TtlCache<VerifyResult>
  private readonly opts: Required<Omit<VerifyOptions, "mailto">> & { mailto?: string }

  constructor(options: VerifyOptions = {}) {
    this.opts = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
      concurrency: options.concurrency ?? 6,
      cacheTtlMs: options.cacheTtlMs ?? DEFAULT_TTL,
      offline: options.offline ?? false,
      ...(options.mailto ? { mailto: options.mailto } : {}),
    }
    this.cache = new TtlCache<VerifyResult>(this.opts.cacheTtlMs)
  }

  /** Verify a single DOI. Never throws. */
  async verifyDoi(doi: string, expectedTitle = ""): Promise<VerifyResult> {
    const cached = this.cache.get(doi)
    if (cached) return cached

    if (this.opts.offline) {
      return { status: "skipped", detail: "offline mode: DOI not verified" }
    }

    const requestOpts = {
      timeoutMs: this.opts.timeoutMs,
      ...(this.opts.mailto ? { mailto: this.opts.mailto } : {}),
    }

    let result: VerifyResult

    try {
      const hit = await fromCrossref(doi, requestOpts)

      if (hit.retracted) {
        result = {
          status: "retracted",
          source: "crossref",
          title: hit.title,
          retractionDois: hit.retractionDois,
          detail:
            `retracted (Crossref / Retraction Watch)` +
            (hit.retractionDois.length ? `; notice DOI ${hit.retractionDois.join(", ")}` : ""),
        }
      } else if (expectedTitle && hit.title && !titlesMatch(hit.title, expectedTitle)) {
        result = {
          status: "title-mismatch",
          source: "crossref",
          title: hit.title,
          detail: `DOI resolves to "${truncate(hit.title, 90)}" but the bibliography says "${truncate(expectedTitle, 90)}"`,
        }
      } else {
        result = { status: "ok", source: "crossref", title: hit.title }
      }
    } catch (crossrefError) {
      // 404 = "unknown DOI here", 429/5xx/network = "we could not ask".
      // Both fall through; only the exhausted case tells them apart.
      const status = crossrefError instanceof RegistryError ? crossrefError.status : 0

      if (status === 404) {
        result = await this.fallback(doi, expectedTitle, requestOpts)
      } else {
        result = await this.fallback(
          doi,
          expectedTitle,
          requestOpts,
          `Crossref unavailable (${describeError(crossrefError)})`,
        )
      }
    }

    this.cache.set(doi, result)
    return result
  }

  private async fallback(
    doi: string,
    expectedTitle: string,
    requestOpts: Parameters<typeof getJson>[1],
    firstProblem?: string,
  ): Promise<VerifyResult> {
    const problems: string[] = firstProblem ? [firstProblem] : []
    let mismatch: VerifyResult | undefined

    // OpenAlex sometimes attaches the wrong record to a DOI it does not own, so
    // a title mismatch from one registry is only a finding if no other registry
    // vouches for the title. arXiv DOIs (10.48550) are registered with DataCite,
    // so ask it first.
    const registries: Array<{
      source: "openalex" | "datacite"
      label: string
      lookup: typeof fromOpenAlex
    }> = [
      { source: "openalex", label: "OpenAlex", lookup: fromOpenAlex },
      { source: "datacite", label: "DataCite", lookup: fromDataCite },
    ]
    if (doi.toLowerCase().startsWith("10.48550/")) registries.reverse()

    for (const { source, label, lookup } of registries) {
      try {
        const hit = await lookup(doi, requestOpts)
        if (expectedTitle && hit.title && !titlesMatch(hit.title, expectedTitle)) {
          mismatch ??= {
            status: "title-mismatch",
            source,
            title: hit.title,
            detail: `DOI resolves to "${truncate(hit.title, 90)}" but the bibliography says "${truncate(expectedTitle, 90)}"`,
          }
          continue
        }
        return { status: "ok", source, title: hit.title }
      } catch (error) {
        const status = error instanceof RegistryError ? error.status : 0
        if (status !== 404) problems.push(`${label} unavailable (${describeError(error)})`)
      }
    }

    if (mismatch) {
      // A registry we could not reach might have held the matching record.
      if (problems.length === 0) return mismatch
      return {
        status: "error",
        detail: `could not confirm this DOI: ${mismatch.detail}; ${problems.join("; ")}`,
      }
    }

    if (problems.length > 0) {
      return {
        status: "error",
        detail: `could not check this DOI: ${problems.join("; ")}`,
      }
    }

    return {
      status: "unresolved",
      detail: doi.toLowerCase().startsWith("10.48550/arxiv.")
        ? `arXiv ID ${doi.slice("10.48550/arxiv.".length)} not found (no DOI registered for it in DataCite or OpenAlex)`
        : "DOI not found in Crossref, OpenAlex or DataCite",
    }
  }

  /** Verify every entry of a bibliography in parallel. */
  async verifyEntries(entries: readonly BibEntry[]): Promise<Array<{ entry: BibEntry; result: VerifyResult }>> {
    const withDoi = entries.filter((e) => entryDoi(e))
    const results = await mapLimit(withDoi, this.opts.concurrency, async (entry) => ({
      entry,
      result: await this.verifyDoi(entryDoi(entry) as string, entry.fields.title ?? ""),
    }))
    return results
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "timeout"
    return error.message
  }
  return String(error)
}
