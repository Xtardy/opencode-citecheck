import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { declaredBibNames, resolveBib } from "../src/locate.ts"

test("declaredBibNames extracts bibliography and addbibresource declarations", () => {
  // Given
  const source = String.raw`\bibliography{refs, other.bib} \addbibresource[location=local]{nested/library.bib}`

  // When
  const names = declaredBibNames(source)

  // Then
  assert.deepEqual(names, ["refs", "other", "nested/library"])
})

test("resolveBib chooses a bibliography explicitly declared by the document", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "citecheck-locate-declared-"))
  try {
    const paper = join(root, "paper.tex")
    const bibliography = join(root, "custom.bib")
    writeFileSync(paper, String.raw`\bibliography{custom}`)
    writeFileSync(bibliography, "@article{x,title={X}}")

    // When
    const resolution = resolveBib(paper, 0)

    // Then
    assert.deepEqual(resolution, { path: bibliography, via: "declared" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolveBib prefers a conventional sibling name when several bibliographies exist", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "citecheck-locate-conventional-"))
  try {
    const paper = join(root, "paper.tex")
    writeFileSync(paper, "No declaration")
    writeFileSync(join(root, "references.bib"), "")
    writeFileSync(join(root, "other.bib"), "")

    // When
    const resolution = resolveBib(paper, 0)

    // Then
    assert.deepEqual(resolution, { path: join(root, "references.bib"), via: "conventional" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolveBib returns the only sibling bibliography", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "citecheck-locate-single-"))
  try {
    const paper = join(root, "paper.tex")
    const bibliography = join(root, "sources.bib")
    writeFileSync(paper, "No declaration")
    writeFileSync(bibliography, "")

    // When
    const resolution = resolveBib(paper, 0)

    // Then
    assert.deepEqual(resolution, { path: bibliography, via: "single" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolveBib reports sorted candidates when sibling bibliographies are ambiguous", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "citecheck-locate-ambiguous-"))
  try {
    const paper = join(root, "paper.tex")
    writeFileSync(paper, "No declaration")
    writeFileSync(join(root, "zeta.bib"), "")
    writeFileSync(join(root, "alpha.bib"), "")

    // When
    const resolution = resolveBib(paper, 0)

    // Then
    assert.deepEqual(resolution, {
      via: "ambiguous",
      candidates: [join(root, "alpha.bib"), join(root, "zeta.bib")],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolveBib walks upward only within the requested depth", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "citecheck-locate-depth-"))
  try {
    const child = join(root, "chapter")
    mkdirSync(child)
    const paper = join(child, "paper.tex")
    writeFileSync(paper, "No declaration")
    writeFileSync(join(root, "sources.bib"), "")

    // When
    const shallow = resolveBib(paper, 0)
    const deep = resolveBib(paper, 1)

    // Then
    assert.deepEqual(shallow, { via: "none" })
    assert.deepEqual(deep, { path: join(root, "sources.bib"), via: "single" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
