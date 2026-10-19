/**
 * Turning verification results into text the model will actually act on.
 *
 * Two lessons from testing this against real agents shaped this file:
 *
 * 1. The message must be factually exact. Models inspect the provenance of
 *    an injected warning. If we claim "verified against Crossref" when we
 *    only checked a local file, the model will notice and ignore the warning.
 *
 * 2. The message must not overstate its authority. It is a signal attached to
 *    a tool result, not a hard gate. Telling the model "you must" is fine;
 *    pretending the write failed would be a lie the model can detect.
 */

import type { BibEntry } from "./bib.js"
import type { VerifyResult } from "./verify.js"

export interface Issue {
  /** Citation key or DOI the issue is about. */
  key: string
  /** What kind of problem this is. */
  kind: "missing-key" | "retracted" | "unresolved" | "title-mismatch" | "no-doi" | "no-bib" | "ambiguous-bib" | "error"
  /** One-line explanation, already human-readable. */
  detail: string
}

export interface ReportInput {
  file: string
  bibPath?: string
  issues: Issue[]
}

/** Build the block appended to a tool result. Returns "" when there is nothing to say. */
export function formatReport(input: ReportInput): string {
  if (input.issues.length === 0) return ""

  const lines: string[] = []
  const count = input.issues.length
  const plural = count === 1 ? "" : "s"

  lines.push("")
  lines.push("")
  lines.push(
    `[citecheck] ${count} reference problem${plural} found in ${input.file}.`,
  )
  if (input.bibPath) {
    lines.push(`Bibliography: ${input.bibPath}`)
  }

  for (const issue of input.issues) {
    lines.push(`  - ${issue.key}: ${issue.detail}`)
  }

  lines.push("")
  lines.push(guidance(input))

  return lines.join("\n")
}

function guidance(input: ReportInput): string {
  const kinds = new Set(input.issues.map((i) => i.kind))

  const parts: string[] = []

  if (kinds.has("missing-key")) {
    parts.push(
      `A key that is cited but absent from the bibliography is a broken reference: ` +
        `either add the entry to ${input.bibPath ?? "the .bib file"} or remove the citation.`,
    )
  }

  if (kinds.has("retracted")) {
    parts.push(
      `A retracted paper must not be cited as supporting evidence. ` +
        `Remove it, or cite it explicitly as retracted if that is the point being made.`,
    )
  }

  if (kinds.has("unresolved") || kinds.has("title-mismatch")) {
    parts.push(
      `A DOI that does not resolve, or that resolves to a different paper, is not a real reference. ` +
        `Replace it with a verified source; do not invent a DOI.`,
    )
  }

  if (kinds.has("no-bib")) {
    parts.push(
      `No bibliography was found, so the citation keys could not be checked. ` +
        `Point the document at a .bib file before relying on these citations.`,
    )
  }

  if (kinds.has("ambiguous-bib")) {
    parts.push(
      `Several .bib files are present and none was declared in the document, so nothing was verified. ` +
        `Declare the bibliography explicitly (\\bibliography{...}) to enable checking.`,
    )
  }

  if (kinds.has("error")) {
    parts.push(
      `Some references could not be checked because a registry was unreachable. ` +
        `Do not treat unchecked references as verified.`,
    )
  }

  return parts.join(" ")
}

/** Turn a verification result into an issue, or null when the entry is fine. */
export function issueFromVerify(key: string, result: VerifyResult): Issue | null {
  switch (result.status) {
    case "ok":
      return null
    case "retracted":
      return { key, kind: "retracted", detail: result.detail ?? "retracted" }
    case "unresolved":
      return { key, kind: "unresolved", detail: result.detail ?? "DOI does not resolve" }
    case "title-mismatch":
      return { key, kind: "title-mismatch", detail: result.detail ?? "DOI resolves to a different paper" }
    case "no-doi":
      return { key, kind: "no-doi", detail: "entry has no DOI, so its existence could not be verified" }
    case "error":
      return { key, kind: "error", detail: result.detail ?? "could not be verified" }
    case "skipped":
      return null
  }
}

/** One-line summary for the tool title. */
export function summarize(issues: readonly Issue[]): string {
  if (issues.length === 0) return "no issues"
  const kinds = new Set(issues.map((i) => i.kind))
  if (kinds.size === 1) {
    const only = [...kinds][0]
    return `${issues.length} ${only}`
  }
  return `${issues.length} reference issues`
}

export type { BibEntry }
