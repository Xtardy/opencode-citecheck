import assert from "node:assert/strict"
import { test } from "node:test"

import { formatReport, issueFromVerify, summarize, type Issue } from "../src/report.ts"

test("formatReport returns an empty string when there are no issues", () => {
  // Given
  const input = { file: "paper.tex", issues: [] }

  // When
  const report = formatReport(input)

  // Then
  assert.equal(report, "")
})

test("formatReport includes file, bibliography, issues, and relevant guidance", () => {
  // Given
  const issues: Issue[] = [
    { key: "missing", kind: "missing-key", detail: "cited but absent" },
    { key: "old", kind: "retracted", detail: "retracted by publisher" },
  ]

  // When
  const report = formatReport({ file: "paper.tex", bibPath: "refs.bib", issues })

  // Then
  assert.match(report, /2 reference problems found in paper\.tex/)
  assert.match(report, /Bibliography: refs\.bib/)
  assert.match(report, /missing: cited but absent/)
  assert.match(report, /old: retracted by publisher/)
  assert.match(report, /broken reference/)
  assert.match(report, /retracted paper/)
})

test("issueFromVerify maps every non-ok status and suppresses ok results", () => {
  // Given
  const results = [
    { status: "ok" },
    { status: "retracted", detail: "notice" },
    { status: "unresolved" },
    { status: "title-mismatch", detail: "different" },
    { status: "no-doi" },
    { status: "error", detail: "timeout" },
  ] as const

  // When
  const issues = results.map((result) => issueFromVerify("key", result))

  // Then
  assert.equal(issues[0], null)
  assert.deepEqual(issues.slice(1).map((issue) => issue?.kind), [
    "retracted",
    "unresolved",
    "title-mismatch",
    "no-doi",
    "error",
  ])
})

test("summarize distinguishes no issues, one kind, and mixed kinds", () => {
  // Given
  const same: Issue[] = [
    { key: "a", kind: "unresolved", detail: "missing" },
    { key: "b", kind: "unresolved", detail: "missing" },
  ]
  const mixed: Issue[] = [...same, { key: "c", kind: "retracted", detail: "withdrawn" }]

  // When
  const summaries = [summarize([]), summarize(same), summarize(mixed)]

  // Then
  assert.deepEqual(summaries, ["no issues", "2 unresolved", "3 reference issues"])
})
