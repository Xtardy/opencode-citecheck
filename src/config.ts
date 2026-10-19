/**
 * Plugin configuration.
 *
 * Read from, in order of precedence:
 *   1. `citecheck` key in opencode.json / opencode.jsonc
 *   2. environment variables
 *   3. defaults
 *
 * Everything is optional: the plugin must work with zero configuration.
 */

export interface CitecheckConfig {
  /** Master switch. Default true. */
  enabled: boolean
  /** Verify .bib entries on every write to a .bib file. Default true. */
  checkBibFiles: boolean
  /** Verify cite keys when a document is written. Default true. */
  checkCiteKeys: boolean
  /** Report entries that have no DOI as informational issues. Default false. */
  reportMissingDoi: boolean
  /** Per-request timeout in ms. Default 8000. */
  timeoutMs: number
  /** Max concurrent outbound requests. Default 6. */
  concurrency: number
  /** Cache TTL in ms. Default 6h. */
  cacheTtlMs: number
  /** Contact email for the Crossref/OpenAlex polite pool. */
  mailto?: string
  /** Disable network access entirely. Default false. */
  offline: boolean
  /** How many directories to walk up looking for a .bib. Default 3. */
  bibSearchDepth: number
  /** Extra file extensions to treat as citation-bearing documents. */
  extraExtensions: string[]
}

export const DEFAULT_CONFIG: CitecheckConfig = {
  enabled: true,
  checkBibFiles: true,
  checkCiteKeys: true,
  reportMissingDoi: false,
  timeoutMs: 8_000,
  concurrency: 6,
  cacheTtlMs: 6 * 60 * 60 * 1000,
  offline: false,
  bibSearchDepth: 3,
  extraExtensions: [],
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const v = value.trim().toLowerCase()
    if (["1", "true", "yes", "on"].includes(v)) return true
    if (["0", "false", "no", "off"].includes(v)) return false
  }
  return fallback
}

function asNumber(value: unknown, fallback: number, min = 0): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n < min) return fallback
  return n
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string")
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean)
  return []
}

/**
 * Merge user config over defaults. Unknown keys are ignored; malformed values
 * fall back to the default rather than throwing, because a bad config must not
 * break the agent loop.
 */
export function resolveConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): CitecheckConfig {
  const user = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const base = DEFAULT_CONFIG

  const mailto = user.mailto ?? env.CITECHECK_MAILTO

  return {
    enabled: asBoolean(user.enabled ?? env.CITECHECK_ENABLED, base.enabled),
    checkBibFiles: asBoolean(user.checkBibFiles ?? env.CITECHECK_CHECK_BIB, base.checkBibFiles),
    checkCiteKeys: asBoolean(user.checkCiteKeys ?? env.CITECHECK_CHECK_CITES, base.checkCiteKeys),
    reportMissingDoi: asBoolean(
      user.reportMissingDoi ?? env.CITECHECK_REPORT_MISSING_DOI,
      base.reportMissingDoi,
    ),
    timeoutMs: asNumber(user.timeoutMs ?? env.CITECHECK_TIMEOUT_MS, base.timeoutMs, 100),
    concurrency: asNumber(user.concurrency ?? env.CITECHECK_CONCURRENCY, base.concurrency, 1),
    cacheTtlMs: asNumber(user.cacheTtlMs ?? env.CITECHECK_CACHE_TTL_MS, base.cacheTtlMs, 0),
    ...(typeof mailto === "string" && mailto.trim() ? { mailto: mailto.trim() } : {}),
    offline: asBoolean(user.offline ?? env.CITECHECK_OFFLINE, base.offline),
    bibSearchDepth: asNumber(user.bibSearchDepth, base.bibSearchDepth, 0),
    extraExtensions: [
      ...base.extraExtensions,
      ...asStringArray(user.extraExtensions),
    ].map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`)),
  }
}
