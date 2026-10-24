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

// arXiv identifiers: new style (2005.11401, optional version) and old style (hep-th/9901001).
const ARXIV_ID = String.raw`(\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?`
const ARXIV_BARE = new RegExp(`^${ARXIV_ID}$`, "i")
const ARXIV_IN_TEXT = new RegExp(`(?:arxiv[:\\s]+|arxiv\\.org\\/(?:abs|pdf)\\/)${ARXIV_ID}`, "i")

/** arXiv identifier of an entry (`eprint`, `arxiv`, or mentioned in journal/url/note), without version. */
export function entryArxivId(entry: BibEntry): string | undefined {
  const { eprint, archiveprefix, eprinttype, arxiv, arxivid } = entry.fields

  const prefix = (archiveprefix ?? eprinttype ?? "").trim().toLowerCase()
  if (eprint && (prefix === "arxiv" || prefix === "")) {
    const match = ARXIV_BARE.exec(eprint.trim().replace(/^arxiv:\s*/i, ""))
    if (match?.[1]) return match[1]
  }

  for (const value of [arxiv, arxivid]) {
    const match = value ? ARXIV_BARE.exec(value.trim().replace(/^arxiv:\s*/i, "")) : null
    if (match?.[1]) return match[1]
  }

  for (const name of ["journal", "howpublished", "booktitle", "note", "url"]) {
    const match = ARXIV_IN_TEXT.exec(entry.fields[name] ?? "")
    if (match?.[1]) return match[1]
  }

  return undefined
}

/**
 * The DOI we can verify remotely: the entry's own `doi` field, or, failing
 * that, the DOI arXiv registers for every paper (10.48550/arXiv.<id>), so that
 * preprints without a DOI field are checked too.
 */
export function entryDoi(entry: BibEntry): string | undefined {
  const raw = entry.fields.doi
  const doi = raw ? normalizeDoi(raw) : ""
  if (doi) return doi

  const arxivId = entryArxivId(entry)
  return arxivId ? `10.48550/arxiv.${arxivId.toLowerCase()}` : undefined
}
