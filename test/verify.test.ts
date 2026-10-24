import assert from "node:assert/strict"
import { test } from "node:test"

import { mapLimit, titlesMatch, TtlCache, Verifier } from "../dist/verify.js"
import { stubFetch } from "./fetch-stub.ts"

test("titlesMatch tolerates case, punctuation, markup, and trailing subtitles", () => {
  // Given
  const pairs = [
    ["<i>A Reliable Study</i>", "a reliable study"],
    ["One two three four five six seven eight: a subtitle", "One two three four five six seven eight"],
    ["A sufficiently long paper title", "A sufficiently long paper title with a subtitle"],
  ] as const

  // When
  const matches = pairs.map(([left, right]) => titlesMatch(left, right))

  // Then
  assert.deepEqual(matches, [true, true, true])
})

test("titlesMatch rejects completely different nonempty titles", () => {
  // Given
  const expected = "Reliable methods for molecular biology"
  const registry = "Financial forecasting with neural networks"

  // When
  const matches = titlesMatch(expected, registry)

  // Then
  assert.equal(matches, false)
})

test("mapLimit preserves input order while bounding concurrent work", async () => {
  // Given
  let active = 0
  let peak = 0

  // When
  const results = await mapLimit([3, 1, 2, 4], 2, async (value) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => setImmediate(resolve))
    active -= 1
    return value * 10
  })

  // Then
  assert.deepEqual(results, [30, 10, 20, 40])
  assert.equal(peak, 2)
})

test("mapLimit handles empty input without invoking its mapper", async () => {
  // Given
  let calls = 0

  // When
  const results = await mapLimit([], 0, async () => {
    calls += 1
    return "unexpected"
  })

  // Then
  assert.deepEqual(results, [])
  assert.equal(calls, 0)
})

test("TtlCache stores, replaces, clears, and expires values", (context) => {
  // Given
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now
  context.after(() => {
    Date.now = originalNow
  })
  const cache = new TtlCache<string>(50)

  // When / Then: insertion and replacement
  cache.set("doi", "first")
  cache.set("doi", "second")
  assert.equal(cache.get("doi"), "second")
  assert.equal(cache.size, 1)

  // When / Then: expiration
  now += 51
  assert.equal(cache.get("doi"), undefined)
  assert.equal(cache.size, 0)

  // When / Then: clear
  cache.set("other", "value")
  cache.clear()
  assert.equal(cache.size, 0)
})

test("Verifier reports ok when Crossref resolves a matching title", async (context) => {
  // Given
  const fetchStub = stubFetch({
    "10.1000/ok": { crossref: { status: 200, body: { message: { title: ["Reliable Study"] } } } },
  })
  context.after(fetchStub.restore)
  const verifier = new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: false })

  // When
  const result = await verifier.verifyDoi("10.1000/ok", "Reliable Study")

  // Then
  assert.deepEqual(result, { status: "ok", source: "crossref", title: "Reliable Study" })
})

test("Verifier reports Crossref retractions with notice DOIs", async (context) => {
  // Given
  const fetchStub = stubFetch({
    "10.1000/retracted": {
      crossref: {
        status: 200,
        body: {
          message: {
            title: ["Retracted Study"],
            "updated-by": [{ type: "retraction", DOI: "10.1000/notice" }],
          },
        },
      },
    },
  })
  context.after(fetchStub.restore)
  const verifier = new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: false })

  // When
  const result = await verifier.verifyDoi("10.1000/retracted", "Retracted Study")

  // Then
  assert.equal(result.status, "retracted")
  assert.deepEqual(result.retractionDois, ["10.1000/notice"])
})

test("Verifier reports a title mismatch for a different Crossref record", async (context) => {
  // Given
  const fetchStub = stubFetch({
    "10.1000/mismatch": {
      crossref: { status: 200, body: { message: { title: ["Financial forecasting with neural networks"] } } },
    },
  })
  context.after(fetchStub.restore)
  const verifier = new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: false })

  // When
  const result = await verifier.verifyDoi("10.1000/mismatch", "Reliable methods for molecular biology")

  // Then
  assert.equal(result.status, "title-mismatch")
  assert.equal(result.source, "crossref")
})

test("Verifier reports unresolved only after all three registries return 404", async (context) => {
  // Given
  const fetchStub = stubFetch({
    "10.1000/missing": {
      crossref: { status: 404 },
      openalex: { status: 404 },
      datacite: { status: 404 },
    },
  })
  context.after(fetchStub.restore)
  const verifier = new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: false })

  // When
  const result = await verifier.verifyDoi("10.1000/missing")

  // Then
  assert.equal(result.status, "unresolved")
  assert.equal(fetchStub.calls.length, 3)
})

test("Verifier reports errors rather than unresolved for network and non-404 Crossref failures", async (context) => {
  // Given
  const fetchStub = stubFetch({
    "10.1000/network": { crossref: { error: new TypeError("socket closed") } },
    "10.1000/server": { crossref: { status: 503 } },
  })
  context.after(fetchStub.restore)
  const verifier = new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: false })

  // When
  const network = await verifier.verifyDoi("10.1000/network")
  const server = await verifier.verifyDoi("10.1000/server")

  // Then: an unreachable registry is never a verdict on the DOI, even after
  // the other registries were tried and also failed.
  assert.equal(network.status, "error")
  assert.equal(server.status, "error")
  assert.match(network.detail ?? "", /Crossref unavailable/)
  assert.match(server.detail ?? "", /Crossref unavailable/)
  assert.equal(fetchStub.calls.length, 6)
})

test("Verifier reports unresolved only when every registry answered 404", async (context) => {
  // Given
  const fetchStub = stubFetch({
    "10.1000/allmissing": {
      crossref: { status: 404 },
      openalex: { status: 404 },
      datacite: { status: 404 },
    },
  })
  context.after(fetchStub.restore)
  const verifier = new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: false })

  // When
  const result = await verifier.verifyDoi("10.1000/allmissing")

  // Then
  assert.equal(result.status, "unresolved")
  assert.doesNotMatch(result.detail ?? "", /unavailable/)
  assert.equal(fetchStub.calls.length, 3)
})

test("Verifier serves a second DOI verification from cache", async (context) => {
  // Given
  const fetchStub = stubFetch({
    "10.1000/cached": { crossref: { status: 200, body: { message: { title: ["Cached Study"] } } } },
  })
  context.after(fetchStub.restore)
  const verifier = new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: false })

  // When
  const first = await verifier.verifyDoi("10.1000/cached", "Cached Study")
  const second = await verifier.verifyDoi("10.1000/cached", "A deliberately different expected title")

  // Then
  assert.strictEqual(second, first)
  assert.equal(fetchStub.calls.length, 1)
})

test("Verifier offline mode returns skipped without calling fetch", async (context) => {
  // Given
  const fetchStub = stubFetch({})
  context.after(fetchStub.restore)
  const verifier = new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: true })

  // When
  const result = await verifier.verifyDoi("10.1000/offline")

  // Then
  assert.deepEqual(result, { status: "skipped", detail: "offline mode: DOI not verified" })
  assert.equal(fetchStub.calls.length, 0)
})

test("Verifier accepts an arXiv DOI when OpenAlex has the wrong record but DataCite matches", async (context) => {
  // Given
  const fetchStub = stubFetch({
    "10.48550/arXiv.2005.11401": {
      crossref: { status: 404 },
      openalex: { status: 200, body: { title: "An unrelated record" } },
      datacite: {
        status: 200,
        body: { data: { attributes: { titles: [{ title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks" }] } } },
      },
    },
  })
  context.after(fetchStub.restore)
  const verifier = new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: false })

  // When
  const result = await verifier.verifyDoi(
    "10.48550/arXiv.2005.11401",
    "Retrieval-Augmented Generation for Knowledge-Intensive {NLP} Tasks",
  )

  // Then
  assert.equal(result.status, "ok")
  assert.equal(result.source, "datacite")
})

test("Verifier still reports a mismatch when no registry has a matching title", async (context) => {
  // Given
  const fetchStub = stubFetch({
    "10.1000/wrong": {
      crossref: { status: 404 },
      openalex: { status: 200, body: { title: "Financial forecasting with neural networks" } },
      datacite: { status: 404 },
    },
  })
  context.after(fetchStub.restore)
  const verifier = new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: false })

  // When
  const result = await verifier.verifyDoi("10.1000/wrong", "Reliable methods for molecular biology")

  // Then
  assert.equal(result.status, "title-mismatch")
  assert.equal(result.source, "openalex")
})

test("Verifier reports an error, not a mismatch, when the other registry was unreachable", async (context) => {
  // Given
  const fetchStub = stubFetch({
    "10.1000/half": {
      crossref: { status: 404 },
      openalex: { status: 200, body: { title: "Financial forecasting with neural networks" } },
      datacite: { status: 503 },
    },
  })
  context.after(fetchStub.restore)
  const verifier = new Verifier({ timeoutMs: 100, concurrency: 1, cacheTtlMs: 1_000, offline: false })

  // When
  const result = await verifier.verifyDoi("10.1000/half", "Reliable methods for molecular biology")

  // Then
  assert.equal(result.status, "error")
})
