import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { extractCiteKeys, isBibFile, isSupportedFile } from "../src/cite.ts"

test("extractCiteKeys handles LaTeX citation variants, options, stars, and multiple keys", () => {
  // Given
  const source = String.raw`\citep[see][p.3]{a,b} \citet*{c} \parencite{d} \autocite[][]{e}`

  // When
  const keys = extractCiteKeys(source, "paper.tex")

  // Then
  assert.deepEqual([...keys], ["a", "b", "c", "d", "e"])
})

test("extractCiteKeys returns the wildcard when nocite cites the whole bibliography", () => {
  // Given
  const source = String.raw`\nocite{*}`

  // When
  const keys = extractCiteKeys(source, "paper.tex")

  // Then
  assert.deepEqual([...keys], ["*"])
})

test("extractCiteKeys finds Pandoc keys but rejects an email domain", () => {
  // Given
  const source = readFileSync(new URL("fixtures/notes.md", import.meta.url), "utf8")

  // When
  const keys = extractCiteKeys(source, "notes.md")

  // Then
  assert.deepEqual([...keys], ["alpha", "beta"])
  assert.equal(keys.has("example.com"), false)
})

test("extractCiteKeys ignores escaped at-signs and unsupported files", () => {
  // Given
  const source = String.raw`\@literal and @citation`

  // When
  const markdownKeys = extractCiteKeys(source, "notes.md")
  const sourceKeys = extractCiteKeys(String.raw`\cite{citation}`, "main.ts")

  // Then
  assert.deepEqual([...markdownKeys], ["citation"])
  assert.equal(sourceKeys.size, 0)
})

test("isSupportedFile recognizes configured built-in extensions case-insensitively", () => {
  // Given
  const files = ["paper.TEX", "notes.md", "notebook.ipynb", "refs.bib", "script.ts"]

  // When
  const support = files.map(isSupportedFile)

  // Then
  assert.deepEqual(support, [true, true, true, true, false])
})

test("isBibFile accepts only the bib extension case-insensitively", () => {
  // Given
  const files = ["refs.bib", "REFS.BIB", "paper.tex", "bib"]

  // When
  const bibliography = files.map(isBibFile)

  // Then
  assert.deepEqual(bibliography, [true, true, false, false])
})
