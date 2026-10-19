#!/usr/bin/env node
/**
 * Standalone CLI, for CI and for people who are not using OpenCode.
 *
 *   citecheck check paper.tex
 *   citecheck check references.bib
 *   citecheck check . --fail-on retracted
 *
 * Exit codes:
 *   0  no problems
 *   1  reference problems found
 *   2  usage error, or verification was inconclusive (registries unreachable)
 */

import { resolve, extname, join } from "node:path"
import { readdirSync, statSync } from "node:fs"

import { checkFile } from "../dist/check.js"
import { resolveConfig } from "../dist/config.js"
import { Verifier } from "../dist/verify.js"
import { formatReport } from "../dist/report.js"

function usage() {
  process.stderr.write(
    `citecheck — verify citations and DOIs

Usage:
  citecheck check <file-or-dir> [options]

Options:
  --fail-on <kind>   any | retracted | unresolved | never   (default: any)
  --offline          skip network verification
  --json             machine-readable output
  --mailto <email>   contact address for the Crossref/OpenAlex polite pool
  -h, --help         show this help
`,
  )
  process.exit(2)
}

function parseArgs(argv) {
  const args = { target: "", failOn: "any", offline: false, json: false, mailto: undefined }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "-h" || arg === "--help") usage()
    else if (arg === "--offline") args.offline = true
    else if (arg === "--json") args.json = true
    else if (arg === "--fail-on") args.failOn = argv[++i] ?? "any"
    else if (arg === "--mailto") args.mailto = argv[++i]
    else if (arg === "check") continue
    else if (!args.target) args.target = arg
    else usage()
  }

  if (!args.target) usage()

  if (!["any", "retracted", "unresolved", "never"].includes(args.failOn)) {
    process.stderr.write(`citecheck: invalid --fail-on value: ${args.failOn}\n`)
    process.exit(2)
  }

  return args
}

const CHECKABLE = new Set([".bib", ".tex", ".latex", ".ltx", ".md", ".markdown", ".rmd", ".qmd"])

function collectFiles(target) {
  const path = resolve(target)
  let stat
  try {
    stat = statSync(path)
  } catch {
    process.stderr.write(`citecheck: no such file or directory: ${target}\n`)
    process.exit(2)
  }

  if (stat.isFile()) return [path]

  const out = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git" || name.startsWith(".")) continue
      const full = join(dir, name)
      let s
      try {
        s = statSync(full)
      } catch {
        continue
      }
      if (s.isDirectory()) walk(full, depth + 1)
      else if (CHECKABLE.has(extname(full).toLowerCase())) out.push(full)
    }
  }
  walk(path, 0)
  return out
}

function shouldFail(issues, failOn) {
  if (failOn === "never") return false
  if (issues.length === 0) return false
  const findings = issues.filter((i) => i.kind !== "error")
  if (findings.length === 0) return false
  if (failOn === "any") return true
  if (failOn === "retracted") return findings.some((i) => i.kind === "retracted")
  if (failOn === "unresolved") {
    return findings.some((i) => i.kind === "unresolved" || i.kind === "title-mismatch")
  }
  return true
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const config = resolveConfig(
    {
      offline: args.offline,
      ...(args.mailto ? { mailto: args.mailto } : {}),
      reportMissingDoi: false,
    },
    process.env,
  )

  const verifier = new Verifier({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
    cacheTtlMs: config.cacheTtlMs,
    offline: config.offline,
    ...(config.mailto ? { mailto: config.mailto } : {}),
  })

  const files = collectFiles(args.target)
  if (files.length === 0) {
    process.stderr.write("citecheck: no .bib, .tex or .md files found\n")
    process.exit(0)
  }

  let total = 0
  let notVerified = 0
  let inconclusive = 0
  let failed = false
  const jsonResults = []
  const seen = new Set()

  const documents = files.filter((f) => extname(f).toLowerCase() !== ".bib")
  const bibs = files.filter((f) => extname(f).toLowerCase() === ".bib")

  for (const file of [...documents, ...bibs]) {
    const outcome = await checkFile({ file, config, verifier })
    if (outcome.notVerified) notVerified += outcome.notVerified
    if (outcome.issues.length === 0) continue

    const issues = outcome.issues.filter((issue) => {
      const signature = `${issue.key}\u0000${issue.kind}\u0000${issue.detail}`
      if (seen.has(signature)) return false
      seen.add(signature)
      return true
    })
    if (issues.length === 0) continue

    total += issues.length
    inconclusive += issues.filter((i) => i.kind === "error").length
    if (shouldFail(issues, args.failOn)) failed = true

    if (args.json) {
      jsonResults.push({
        file,
        ...(outcome.bibPath ? { bibPath: outcome.bibPath } : {}),
        ...(outcome.notVerified ? { notVerified: outcome.notVerified } : {}),
        issues,
      })
    } else {
      process.stdout.write(
        formatReport({
          file,
          ...(outcome.bibPath ? { bibPath: outcome.bibPath } : {}),
          issues,
        }) + "\n",
      )
    }
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ total, notVerified, inconclusive, results: jsonResults }, null, 2) + "\n",
    )
  } else if (total === 0) {
    process.stdout.write(`citecheck: ${files.length} file(s) checked, no problems found\n`)
  } else {
    process.stdout.write(`\ncitecheck: ${total} problem(s) in ${files.length} file(s)\n`)
  }

  if (notVerified > 0 && !args.json) {
    process.stdout.write(
      `citecheck: ${notVerified} reference(s) not verified (offline mode). Unchecked is not verified.\n`,
    )
  }

  if (failed) process.exit(1)
  if (inconclusive > 0) {
    process.stderr.write(
      `citecheck: ${inconclusive} reference(s) could not be checked. Unchecked is not verified.\n`,
    )
    process.exit(2)
  }
  process.exit(0)
}

main().catch((error) => {
  process.stderr.write(`citecheck: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
})
