import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { entryDoi, normalizeDoi, parseBib } from "../src/bib.ts"

const fixture = (name: string): string => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")

test("parseBib parses two ordinary entries when given a valid bibliography", () => {
  // Given
  const source = fixture("valid.bib")

  // When
  const entries = parseBib(source)

  // Then
  assert.deepEqual(entries.map(({ type, key }) => ({ type, key })), [
    { type: "article", key: "alpha" },
    { type: "inproceedings", key: "beta" },
  ])
})

test("parseBib preserves nested braces when a title contains protected words", () => {
  // Given
  const source = fixture("nested.bib")

  // When
  const entries = parseBib(source)

  // Then
  assert.equal(entries[0]?.fields.title, "The {DNA} of {RNA}")
})

test("parseBib keeps commas when a field uses a quoted value", () => {
  // Given
  const source = fixture("quoted.bib")

  // When
  const entries = parseBib(source)

  // Then
  assert.equal(entries[0]?.fields.title, "A, B, and C")
})

test("parseBib skips string, comment, and preamble blocks", () => {
  // Given
  const source = fixture("strings.bib")

  // When
  const entries = parseBib(source)

  // Then
  assert.deepEqual(entries.map(({ key }) => key), ["real"])
})

test("parseBib returns parsed entries before an unbalanced trailing entry", () => {
  // Given
  const source = "@article{good, title={Good}}\n@article{broken, title={Broken}"

  // When
  const entries = parseBib(source)

  // Then
  assert.deepEqual(entries.map(({ key }) => key), ["good"])
})

test("normalizeDoi strips resolver and DOI prefixes and lowercases", () => {
  // Given
  const values = [" https://doi.org/10.1038/X ", "http://dx.doi.org/10.1038/X", "DOI: 10.1038/X"]

  // When
  const normalized = values.map(normalizeDoi)

  // Then
  assert.deepEqual(normalized, ["10.1038/x", "10.1038/x", "10.1038/x"])
})

test("entryDoi returns a normalized DOI when the field is present", () => {
  // Given
  const entry = parseBib(fixture("valid.bib"))[1]

  // When
  const doi = entry === undefined ? undefined : entryDoi(entry)

  // Then
  assert.equal(doi, "10.1000/beta")
})

test("entryDoi returns undefined when the DOI is absent or blank", () => {
  // Given
  const entries = parseBib("@article{missing,title={Missing}} @article{blank,title={Blank},doi={ }}")

  // When
  const dois = entries.map(entryDoi)

  // Then
  assert.deepEqual(dois, [undefined, undefined])
})
