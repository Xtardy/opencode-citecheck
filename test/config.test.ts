import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_CONFIG, resolveConfig } from "../src/config.ts"

test("resolveConfig returns defaults for absent or malformed input", () => {
  // Given
  const emptyEnvironment: NodeJS.ProcessEnv = {}

  // When
  const absent = resolveConfig(undefined, emptyEnvironment)
  const malformed = resolveConfig("invalid", emptyEnvironment)

  // Then
  assert.deepEqual(absent, DEFAULT_CONFIG)
  assert.deepEqual(malformed, DEFAULT_CONFIG)
})

test("resolveConfig applies environment overrides and parses supported scalar forms", () => {
  // Given
  const environment: NodeJS.ProcessEnv = {
    CITECHECK_ENABLED: "off",
    CITECHECK_CHECK_BIB: "0",
    CITECHECK_CHECK_CITES: "no",
    CITECHECK_REPORT_MISSING_DOI: "yes",
    CITECHECK_TIMEOUT_MS: "1200",
    CITECHECK_CONCURRENCY: "2",
    CITECHECK_CACHE_TTL_MS: "0",
    CITECHECK_MAILTO: " env@example.com ",
    CITECHECK_OFFLINE: "true",
  }

  // When
  const config = resolveConfig({}, environment)

  // Then
  assert.deepEqual(config, {
    ...DEFAULT_CONFIG,
    enabled: false,
    checkBibFiles: false,
    checkCiteKeys: false,
    reportMissingDoi: true,
    timeoutMs: 1_200,
    concurrency: 2,
    cacheTtlMs: 0,
    mailto: "env@example.com",
    offline: true,
  })
})

test("resolveConfig gives user settings precedence and normalizes extension overrides", () => {
  // Given
  const environment: NodeJS.ProcessEnv = {
    CITECHECK_ENABLED: "false",
    CITECHECK_TIMEOUT_MS: "500",
    CITECHECK_MAILTO: "env@example.com",
  }
  const raw = {
    enabled: true,
    timeoutMs: 900,
    concurrency: 4,
    bibSearchDepth: 1,
    mailto: " user@example.com ",
    extraExtensions: ["TXT", ".Org", 42],
  }

  // When
  const config = resolveConfig(raw, environment)

  // Then
  assert.equal(config.enabled, true)
  assert.equal(config.timeoutMs, 900)
  assert.equal(config.concurrency, 4)
  assert.equal(config.bibSearchDepth, 1)
  assert.equal(config.mailto, "user@example.com")
  assert.deepEqual(config.extraExtensions, [".txt", ".org"])
})

test("resolveConfig falls back when numeric and boolean overrides are invalid", () => {
  // Given
  const raw = {
    enabled: "perhaps",
    timeoutMs: 99,
    concurrency: 0,
    cacheTtlMs: -1,
    bibSearchDepth: -1,
    extraExtensions: "txt, .RST,",
  }

  // When
  const config = resolveConfig(raw, {})

  // Then
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled)
  assert.equal(config.timeoutMs, DEFAULT_CONFIG.timeoutMs)
  assert.equal(config.concurrency, DEFAULT_CONFIG.concurrency)
  assert.equal(config.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs)
  assert.equal(config.bibSearchDepth, DEFAULT_CONFIG.bibSearchDepth)
  assert.deepEqual(config.extraExtensions, [".txt", ".rst"])
})
