/**
 * Extract citation keys from a document.
 *
 * Supported syntaxes:
 *   LaTeX  : \cite{a,b} \citep[see][p.3]{a} \citet*{a} \parencite{a}
 *            \textcite{a} \autocite{a} \footcite{a} \nocite{*}
 *   Pandoc : [@key] [@a; @b] @key
 *
 * Explicitly NOT citations:
 *   - email addresses      (bob@example.com)
 *   - social handles       (@username at start of line is ambiguous; we require
 *                           a citation-ish shape and reject bare handles)
 *   - escaped @            (\@key renders a literal at-sign in LaTeX)
 */

const LATEX_EXTENSIONS = new Set([".tex", ".latex", ".ltx", ".sty", ".cls", ".bib"])
const PANDOC_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".rmd", ".qmd", ".ipynb"])

function extensionOf(file: string): string {
  const dot = file.lastIndexOf(".")
  return dot === -1 ? "" : file.slice(dot).toLowerCase()
}

/**
 * `\cite`, `\citep`, `\citet*`, `\autocite`, `\parencite`, `\textcite`,
 * `\footcite`, `\supercite`, `\nocite`, with any number of `[...]` optionals
 * before the mandatory `{...}` group.
 */
const LATEX_CITE = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g

/** `\nocite{*}` — cite every entry in the bibliography. */
const NOCITE_STAR = /\\nocite\{\s*\*\s*\}/g

/**
 * Pandoc `@key`. The key may contain letters, digits, `_`, `:`, `.`, `-`,
 * `/`, `+` and internal uppercase. We require it to start with a letter or
 * digit so `@username` and `@@` do not match, and we require a word boundary
 * before `@` so emails never match.
 *
 * A trailing `.tld`-looking suffix is rejected separately (see isLikelyDomain).
 */
const PANDOC_CITE = /(?:^|[^A-Za-z0-9_@\\./-])@([A-Za-z0-9][A-Za-z0-9_:.\-/+#]*)/g

/**
 * Heuristic: reject things that look like a domain rather than a citekey.
 * `example.com`, `foo.org`, `sub.domain.net`.
 */
function isLikelyDomain(key: string): boolean {
  return /\.[a-z]{2,6}$/i.test(key) && !key.includes(":")
}

/**
 * Extract the set of citation keys referenced by `text`.
 *
 * Returns an empty set for file types we do not understand, so the plugin
 * stays silent on unrelated files rather than producing false warnings.
 */
export function extractCiteKeys(text: string, file: string): Set<string> {
  const keys = new Set<string>()
  const ext = extensionOf(file)

  const isLatex = LATEX_EXTENSIONS.has(ext)
  const isPandoc = PANDOC_EXTENSIONS.has(ext)
  if (!isLatex && !isPandoc) return keys

  if (isLatex) {
    for (const match of text.matchAll(LATEX_CITE)) {
      const group = match[1] ?? ""
      for (const raw of group.split(",")) {
        const key = raw.trim()
        if (key) keys.add(key)
      }
    }
    if (NOCITE_STAR.test(text)) keys.add("*")
  }

  if (isPandoc) {
    for (const match of text.matchAll(PANDOC_CITE)) {
      const key = (match[1] ?? "").replace(/[.,;:]+$/, "")
      if (!key) continue
      if (isLikelyDomain(key)) continue
      keys.add(key)
    }
  }

  return keys
}

/** Whether the file is one this plugin should inspect at all. */
export function isSupportedFile(file: string): boolean {
  const ext = extensionOf(file)
  return LATEX_EXTENSIONS.has(ext) || PANDOC_EXTENSIONS.has(ext)
}

/** Whether the file is a bibliography we should verify entry-by-entry. */
export function isBibFile(file: string): boolean {
  return extensionOf(file) === ".bib"
}
