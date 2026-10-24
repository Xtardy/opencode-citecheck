import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { checkFile } from "../dist/check.js"
import { DEFAULT_CONFIG, type CitecheckConfig } from "../src/config.ts"
import { Verifier } from "../dist/verify.js"
import { stubFetch } from "./fetch-stub.ts"

const onlineConfig: CitecheckConfig = { ...DEFAULT_CONFIG, timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000 }

function verifier(): Verifier {
  return new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: false })
}

test("checkFile verifies a bibliography end-to-end and reports registry outcomes", async (context) => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "citecheck-check-bib-"))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "references.bib")
  const content = [
    "@article{ok,title={Reliable Study},doi={10.1000/ok}}",
    "@article{retracted,title={Retracted Study},doi={10.1000/retracted}}",
    "@article{mismatch,title={Molecular biology methods},doi={10.1000/mismatch}}",
    "@article{missing,title={Missing Study},doi={10.1000/missing}}",
    "@article{error,title={Error Study},doi={10.1000/error}}",
    "@article{without,title={No DOI}}",
  ].join("\n")
  writeFileSync(file, content)
  const fetchStub = stubFetch({
    "10.1000/ok": { crossref: { status: 200, body: { message: { title: ["Reliable Study"] } } } },
    "10.1000/retracted": {
      crossref: {
        status: 200,
        body: { message: { title: ["Retracted Study"], "updated-by": [{ type: "retraction", DOI: "10.1000/notice" }] } },
      },
    },
    "10.1000/mismatch": {
      crossref: { status: 200, body: { message: { title: ["Financial forecasting with neural networks"] } } },
    },
    "10.1000/missing": {
      crossref: { status: 404 },
      openalex: { status: 404 },
      datacite: { status: 404 },
    },
    "10.1000/error": { crossref: { error: new TypeError("network unavailable") } },
  })
  context.after(fetchStub.restore)

  // When
  const outcome = await checkFile({
    file,
    config: { ...onlineConfig, reportMissingDoi: true },
    verifier: verifier(),
  })

  // Then
  assert.equal(outcome.bibPath, file)
  assert.deepEqual(outcome.issues.map(({ key, kind }) => ({ key, kind })), [
    { key: "retracted", kind: "retracted" },
    { key: "mismatch", kind: "title-mismatch" },
    { key: "missing", kind: "unresolved" },
    { key: "error", kind: "error" },
    { key: "without", kind: "no-doi" },
  ])
})

test("checkFile resolves a declared bibliography and verifies only cited entries", async (context) => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "citecheck-check-cites-"))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "paper.tex")
  writeFileSync(file, String.raw`\cite{alpha,absent}\bibliography{valid}`)
  writeFileSync(
    join(root, "valid.bib"),
    "@article{alpha,title={Reliable Alpha Study},doi={10.1000/alpha}}\n@article{uncited,title={Uncited},doi={10.1000/uncited}}",
  )
  const fetchStub = stubFetch({
    "10.1000/alpha": { crossref: { status: 200, body: { message: { title: ["Reliable Alpha Study"] } } } },
  })
  context.after(fetchStub.restore)

  // When
  const outcome = await checkFile({ file, config: onlineConfig, verifier: verifier() })

  // Then
  assert.equal(outcome.bibPath, join(root, "valid.bib"))
  assert.deepEqual(outcome.issues, [
    { key: "absent", kind: "missing-key", detail: "cited but not present in valid.bib" },
  ])
  assert.equal(fetchStub.calls.length, 1)
})

test("checkFile expands nocite wildcard without creating a missing wildcard issue", async (context) => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "citecheck-check-nocite-"))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "paper.tex")
  writeFileSync(file, String.raw`\nocite{*}\bibliography{valid}`)
  writeFileSync(join(root, "valid.bib"), "@article{alpha,title={Alpha},doi={10.1000/alpha}}")
  const fetchStub = stubFetch({
    "10.1000/alpha": { crossref: { status: 200, body: { message: { title: ["Alpha"] } } } },
  })
  context.after(fetchStub.restore)

  // When
  const outcome = await checkFile({ file, config: onlineConfig, verifier: verifier() })

  // Then
  assert.deepEqual(outcome.issues, [])
  assert.equal(fetchStub.calls.length, 1)
})

test("checkFile reports missing and ambiguous bibliographies without network access", async (context) => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "citecheck-check-resolution-"))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const missing = join(root, "missing.tex")
  writeFileSync(missing, String.raw`\cite{alpha}`)
  const ambiguous = join(root, "ambiguous.tex")
  writeFileSync(ambiguous, String.raw`\cite{alpha}`)
  writeFileSync(join(root, "alpha.bib"), "")
  writeFileSync(join(root, "beta.bib"), "")
  const fetchStub = stubFetch({})
  context.after(fetchStub.restore)

  // When
  rmSync(join(root, "alpha.bib"))
  rmSync(join(root, "beta.bib"))
  const noBibliography = await checkFile({ file: missing, config: onlineConfig, verifier: verifier() })
  writeFileSync(join(root, "alpha.bib"), "")
  writeFileSync(join(root, "beta.bib"), "")
  const ambiguousBibliography = await checkFile({ file: ambiguous, config: onlineConfig, verifier: verifier() })

  // Then
  assert.equal(noBibliography.issues[0]?.kind, "no-bib")
  assert.equal(ambiguousBibliography.issues[0]?.kind, "ambiguous-bib")
  assert.equal(fetchStub.calls.length, 0)
})

test("checkFile marks a declared but not yet written bibliography as pending", async (context) => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "citecheck-check-pending-"))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const tex = join(root, "note.tex")
  writeFileSync(tex, String.raw`\cite{alpha} \bibliography{note}`)
  const fetchStub = stubFetch({})
  context.after(fetchStub.restore)

  // When
  const outcome = await checkFile({ file: tex, config: onlineConfig, verifier: verifier() })

  // Then
  assert.equal(outcome.issues[0]?.kind, "no-bib")
  assert.equal(outcome.issues[0]?.pending, true)
  assert.match(outcome.issues[0]?.detail ?? "", /note\.bib is declared but does not exist yet/)
  assert.equal(fetchStub.calls.length, 0)
})

test("checkFile skips disabled, unsupported, and unreadable inputs without network access", async (context) => {
  // Given
  const fetchStub = stubFetch({})
  context.after(fetchStub.restore)
  const instance = verifier()

  // When
  const disabled = await checkFile({
    file: "/missing/paper.tex",
    config: { ...onlineConfig, enabled: false },
    verifier: instance,
  })
  const unsupported = await checkFile({ file: "/missing/code.ts", config: onlineConfig, verifier: instance })
  const unreadable = await checkFile({ file: "/missing/paper.tex", config: onlineConfig, verifier: instance })

  // Then
  assert.deepEqual([disabled.skipped, unsupported.skipped, unreadable.skipped], ["disabled", "unsupported", "unreadable"])
  assert.equal(fetchStub.calls.length, 0)
})
