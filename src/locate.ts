/**
 * Locating the bibliography for a given source file.
 *
 * The common layouts we support, in priority order:
 *
 *   1. a `\bibliography{refs}` / `\addbibresource{refs.bib}` declaration in
 *      the .tex file itself (most accurate)
 *   2. a sibling .bib file with a conventional name
 *   3. a sibling .bib file, if there is exactly one
 *   4. walking up a few directories (monorepo / chapter layouts)
 *
 * We never guess when several candidates exist: reporting "ambiguous" is
 * better than verifying against the wrong bibliography.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"

export interface BibResolution {
  /** Absolute path to the bibliography, when exactly one was found. */
  path?: string
  /** How it was found. */
  via: "declared" | "conventional" | "single" | "ambiguous" | "none"
  /** Candidate paths when `via === "ambiguous"`. */
  candidates?: string[]
}

const CONVENTIONAL_NAMES = [
  "references.bib",
  "refs.bib",
  "bibliography.bib",
  "biblio.bib",
  "main.bib",
  "citations.bib",
  "library.bib",
]

/** `\bibliography{a,b}` and `\addbibresource{a.bib}`. */
const BIB_DECLARATION = /\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g

/**
 * Names declared in a .tex source, without the .bib extension.
 * `\bibliography{refs,other}` yields ["refs", "other"].
 */
export function declaredBibNames(texSource: string): string[] {
  const names: string[] = []
  for (const match of texSource.matchAll(BIB_DECLARATION)) {
    const group = match[1] ?? ""
    for (const raw of group.split(",")) {
      const name = raw.trim().replace(/\.bib$/i, "")
      if (name) names.push(name)
    }
  }
  return names
}

function bibFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => extname(f).toLowerCase() === ".bib")
      .sort()
  } catch {
    return []
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve the bibliography to use for `file`.
 *
 * `maxDepth` bounds the upward walk; 0 means "this directory only".
 */
export function resolveBib(file: string, maxDepth = 3): BibResolution {
  const dir = dirname(resolve(file))

  // 1. explicit declaration in the source file
  if (extname(file).toLowerCase() !== ".bib") {
    try {
      const source = readFileSync(file, "utf8")
      const declared = declaredBibNames(source)
      const found = declared
        .map((name) => join(dir, `${name}.bib`))
        .filter(isFile)
      if (found.length === 1) return { path: found[0] as string, via: "declared" }
      if (found.length > 1) {
        // More than one declared and present: verify the first, it is the
        // conventional primary bibliography.
        return { path: found[0] as string, via: "declared" }
      }
    } catch {
      // unreadable source: fall through
    }
  }

  // 2/3. sibling files
  let current = dir
  for (let depth = 0; depth <= maxDepth; depth++) {
    const files = bibFilesIn(current)

    for (const name of CONVENTIONAL_NAMES) {
      if (files.includes(name)) {
        return { path: join(current, name), via: depth === 0 ? "conventional" : "single" }
      }
    }

    if (files.length === 1) {
      return { path: join(current, files[0] as string), via: depth === 0 ? "single" : "single" }
    }

    if (files.length > 1) {
      return {
        via: "ambiguous",
        candidates: files.map((f) => join(current, f)),
      }
    }

    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return { via: "none" }
}

/** Short, stable label for messages: the file name only. */
export function bibLabel(path: string): string {
  return basename(path)
}

/** Whether a path exists and looks like a .bib file. */
export function isBibPath(path: string): boolean {
  return existsSync(path) && extname(path).toLowerCase() === ".bib"
}
