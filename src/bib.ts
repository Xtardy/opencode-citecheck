/**
 * Minimal, dependency-free BibTeX parser.
 *
 * Deliberately not a full BibTeX implementation: we only need entry keys,
 * field names and field values. We must, however, be robust against the
 * things that actually appear in real .bib files:
 *
 *   - nested braces in titles  ({The {DNA} of {RNA}})
 *   - quoted values with commas ("A, B, and C")
 *   - @string / @comment / @preamble blocks (must be skipped, not parsed)
 *   - trailing commas, whitespace, CRLF
 *   - fields spanning multiple lines
 *
 * Anything we cannot parse is skipped rather than throwing: a malformed .bib
 * must never take down the agent loop.
 */

export interface BibEntry {
  /** Entry type, lowercased: article, inproceedings, ... */
  type: string
  /** Citation key as written between `{` and the first `,`. */
  key: string
  /** Field name (lowercased) -> raw value (braces/quotes stripped, whitespace collapsed). */
  fields: Record<string, string>
}

const SKIP_TYPES = new Set(["comment", "preamble", "string"])

/**
 * Index of the `}` matching the `{` at `open`, or -1 if unbalanced.
 * Counts braces only; BibTeX values cannot contain unbalanced braces.
 */
function matchingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Split `rest` on top-level commas, respecting `{}` nesting and `"` quoting.
 * Quotes only toggle at brace depth 0, so `{say "hi"}` stays literal.
 */
function splitFields(rest: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inQuote = false
  let start = 0
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (c === '"' && depth === 0) inQuote = !inQuote
    else if (c === "{") depth++
    else if (c === "}") depth--
    else if (c === "," && depth === 0 && !inQuote) {
      parts.push(rest.slice(start, i))
      start = i + 1
    }
  }
  parts.push(rest.slice(start))
  return parts
}

/** Strip one layer of `{}` or `""` and collapse whitespace. */
function cleanValue(raw: string): string {
  let v = raw.trim()
  if (v.startsWith("{") && v.endsWith("}")) v = v.slice(1, -1)
  else if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  return v.replace(/\s+/g, " ").trim()
}

/**
 * Parse a .bib file into entries. Never throws.
 */
export function parseBib(text: string): BibEntry[] {
  const entries: BibEntry[] = []
  let i = 0

  while (true) {
    const at = text.indexOf("@", i)
    if (at === -1) break

    const open = text.indexOf("{", at)
    if (open === -1) break

    const type = text.slice(at + 1, open).trim().toLowerCase()
    const close = matchingBrace(text, open)
    if (close === -1) break

    const body = text.slice(open + 1, close)
    i = close + 1

    if (SKIP_TYPES.has(type)) continue

    const comma = body.indexOf(",")
    const key = (comma === -1 ? body : body.slice(0, comma)).trim()
    if (!key) continue

    const fields: Record<string, string> = {}
    if (comma !== -1) {
      for (const part of splitFields(body.slice(comma + 1))) {
        const eq = part.indexOf("=")
        if (eq === -1) continue
        const name = part.slice(0, eq).trim().toLowerCase()
        if (!name) continue
        fields[name] = cleanValue(part.slice(eq + 1))
      }
    }

    entries.push({ type, key, fields })
  }

  return entries
}

/**
 * Normalise a DOI for comparison: strip the resolver prefix and lowercase.
 * `https://doi.org/10.1038/X` and `10.1038/x` are the same DOI.
 */
export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase()
}

/** True if the entry carries a DOI we can verify remotely. */
export function entryDoi(entry: BibEntry): string | undefined {
  const raw = entry.fields.doi
  if (!raw) return undefined
  const doi = normalizeDoi(raw)
  return doi || undefined
}
