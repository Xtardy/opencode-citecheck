/**
 * The core check: given a file and its new content, produce a list of issues.
 *
 * Kept free of plugin-API types so it can be unit tested and reused by the
 * standalone CLI.
 */

import { readFileSync } from "node:fs"
import { basename, dirname } from "node:path"

import { parseBib, entryDoi, type BibEntry } from "./bib.js"
import { extractCiteKeys, isBibFile, isSupportedFile } from "./cite.js"
import { resolveBib, bibLabel } from "./locate.js"
import { issueFromVerify, type Issue } from "./report.js"
import { Verifier } from "./verify.js"
import type { CitecheckConfig } from "./config.js"

export interface CheckInput {
  /** Absolute path of the file being written. */
  file: string
  /**
   * New content of the file, when known (write tool). When absent we read
   * from disk (edit tool: the file has already been modified).
   */
  content?: string
  config: CitecheckConfig
  verifier: Verifier
}

export interface CheckOutcome {
  issues: Issue[]
  bibPath?: string
  /** Entries whose DOI was deliberately not checked (offline mode). */
  notVerified?: number
  /** True when we could not check at all, as opposed to "checked and clean". */
  skipped?: "unsupported" | "disabled" | "unreadable"
}

/**
 * Inspect one file and report reference problems.
 *
 * Two modes:
 *   - the file is a .bib: verify each entry's DOI
 *   - the file cites: resolve every key against the nearest .bib, then verify
 *     the DOIs of the entries actually cited
 */
export async function checkFile(input: CheckInput): Promise<CheckOutcome> {
  const { file, config, verifier } = input

  if (!config.enabled) return { issues: [], skipped: "disabled" }
  if (!isSupportedFile(file)) return { issues: [], skipped: "unsupported" }

  let content = input.content
  if (content === undefined) {
    try {
      content = readFileSync(file, "utf8")
    } catch {
      return { issues: [], skipped: "unreadable" }
    }
  }

  if (isBibFile(file)) {
    if (!config.checkBibFiles) return { issues: [], skipped: "disabled" }
    return checkBib(file, content, config, verifier)
  }

  if (!config.checkCiteKeys) return { issues: [], skipped: "disabled" }
  return checkCitations(file, content, config, verifier)
}

async function checkBib(
  file: string,
  content: string,
  config: CitecheckConfig,
  verifier: Verifier,
): Promise<CheckOutcome> {
  const entries = parseBib(content)
  const results = await verifier.verifyEntries(entries)

  const issues: Issue[] = []
  let notVerified = 0
  for (const { entry, result } of results) {
    if (result.status === "skipped") {
      notVerified++
      continue
    }
    const issue = issueFromVerify(entry.key, result)
    if (issue) issues.push(issue)
  }

  if (config.reportMissingDoi) {
    for (const entry of entries) {
      if (!entryDoi(entry)) {
        issues.push({
          key: entry.key,
          kind: "no-doi",
          detail: "entry has no DOI, so its existence could not be verified",
        })
      }
    }
  }

  return { issues, bibPath: file, ...(notVerified ? { notVerified } : {}) }
}

async function checkCitations(
  file: string,
  content: string,
  config: CitecheckConfig,
  verifier: Verifier,
): Promise<CheckOutcome> {
  const keys = extractCiteKeys(content, file)
  if (keys.size === 0) return { issues: [] }

  const resolution = resolveBib(file, config.bibSearchDepth)

  if (resolution.via === "none") {
    return {
      issues: [
        {
          key: `${keys.size} citation key(s)`,
          kind: "no-bib",
          detail: `no .bib file found near ${basename(file)}`,
        },
      ],
    }
  }

  if (resolution.via === "ambiguous" || !resolution.path) {
    return {
      issues: [
        {
          key: `${keys.size} citation key(s)`,
          kind: "ambiguous-bib",
          detail: `several .bib files found (${(resolution.candidates ?? []).map(bibLabel).join(", ")}) and none is declared in the document`,
        },
      ],
    }
  }

  const bibPath = resolution.path

  let entries: BibEntry[]
  try {
    entries = parseBib(readFileSync(bibPath, "utf8"))
  } catch {
    return { issues: [], skipped: "unreadable" }
  }

  const byKey = new Map(entries.map((e) => [e.key, e]))
  const issues: Issue[] = []

  // \nocite{*}: the whole bibliography is cited.
  const citesAll = keys.has("*")
  const targetKeys = citesAll ? entries.map((e) => e.key) : [...keys]

  const toVerify: BibEntry[] = []

  for (const key of targetKeys) {
    const entry = byKey.get(key)
    if (!entry) {
      if (!citesAll) {
        issues.push({
          key,
          kind: "missing-key",
          detail: `cited but not present in ${bibLabel(bibPath)}`,
        })
      }
      continue
    }

    if (!entryDoi(entry)) {
      if (config.reportMissingDoi) {
        issues.push({
          key,
          kind: "no-doi",
          detail: "entry has no DOI, so its existence could not be verified",
        })
      }
      continue
    }

    toVerify.push(entry)
  }

  const verified = await verifier.verifyEntries(toVerify)
  let notVerified = 0
  for (const { entry, result } of verified) {
    if (result.status === "skipped") {
      notVerified++
      continue
    }
    const issue = issueFromVerify(entry.key, result)
    if (issue) issues.push(issue)
  }

  return { issues, bibPath, ...(notVerified ? { notVerified } : {}) }
}

export { dirname }
