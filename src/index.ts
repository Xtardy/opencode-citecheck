/**
 * OpenCode plugin entrypoint.
 *
 * Exported as a default object with `server()` (plugin API v1) and `setup()`
 * (plugin API v2), the dual shape OpenCode has supported since 1.18.29.
 * On v1 the `tool.execute.after` hook rewrites the tool result so the agent
 * sees the warning and can fix the file in the same turn.
 */

import { tool } from "@opencode-ai/plugin"

import { checkFile } from "./check.js"
import { resolveConfig, type CitecheckConfig } from "./config.js"
import { formatReport, summarize } from "./report.js"
import { Verifier } from "./verify.js"
import { parseBib, entryDoi } from "./bib.js"
import { readFileSync } from "node:fs"
import { basename } from "node:path"

/** Tools whose output we inspect. */
const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit"])

interface RuntimeState {
  config: CitecheckConfig
  verifier: Verifier
}

/**
 * State shared with the audit tool. The tool has no access to plugin options,
 * so server()/setup() publish the resolved state here. Falls back to defaults
 * when the tool is somehow invoked before the plugin initialised.
 */
let activeState: RuntimeState | undefined

function stateOrFallback(): RuntimeState {
  if (!activeState) activeState = makeState(undefined)
  return activeState
}

function makeState(raw: unknown): RuntimeState {
  const config = resolveConfig(raw)
  const verifier = new Verifier({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
    cacheTtlMs: config.cacheTtlMs,
    offline: config.offline,
    ...(config.mailto ? { mailto: config.mailto } : {}),
  })
  return { config, verifier }
}

/** Extract the written file path from whatever shape the tool used. */
function fileFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const a = args as Record<string, unknown>
  for (const key of ["filePath", "file_path", "path", "filename"]) {
    const value = a[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

/** Extract the new content, when the tool provides it. */
function contentFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const a = args as Record<string, unknown>
  for (const key of ["content", "newString", "text"]) {
    const value = a[key]
    if (typeof value === "string") return value
  }
  return undefined
}

/**
 * Run the check and append the report to `output.output`.
 * Returns true when something was appended.
 */
async function annotate(
  args: unknown,
  output: { title?: string; output?: string; metadata?: unknown },
  state: RuntimeState,
): Promise<boolean> {
  const file = fileFromArgs(args)
  if (!file) return false

  const outcome = await checkFile({
    file,
    ...(contentFromArgs(args) !== undefined ? { content: contentFromArgs(args) as string } : {}),
    config: state.config,
    verifier: state.verifier,
  })

  if (outcome.issues.length === 0) return false

  const report = formatReport({
    file: basename(file),
    ...(outcome.bibPath ? { bibPath: basename(outcome.bibPath) } : {}),
    issues: outcome.issues,
  })

  if (!report) return false

  output.output = `${output.output ?? ""}${report}`
  output.title = `[citecheck] ${summarize(outcome.issues)}`
  output.metadata = {
    ...(output.metadata && typeof output.metadata === "object" ? output.metadata : {}),
    citecheck: {
      file,
      issues: outcome.issues.length,
      kinds: [...new Set(outcome.issues.map((i) => i.kind))],
    },
  }
  return true
}

/**
 * The `citecheck_audit` tool: check a bibliography or document on demand,
 * without waiting for a write.
 */
const auditTool = tool({
  description:
    "Verify citations and bibliography entries against Crossref, OpenAlex and DataCite. " +
    "Reports cited keys missing from the .bib, DOIs that do not resolve, DOIs pointing at a " +
    "different paper, and retracted references. Use before submitting a paper, or whenever " +
    "the user asks whether the references are real.",
  args: {
    file: tool.schema
      .string()
      .describe("Path to a .bib, .tex, .md or other citation-bearing file to audit"),
    reportMissingDoi: tool.schema
      .boolean()
      .optional()
      .describe("Also list entries that have no DOI and therefore cannot be verified"),
  },
  async execute(args, context) {
    const state = stateOrFallback()
    const outcome = await checkFile({
      file: args.file,
      config: { ...state.config, reportMissingDoi: args.reportMissingDoi ?? state.config.reportMissingDoi },
      verifier: state.verifier,
    })

    if (outcome.skipped) {
      return {
        title: "citecheck: nothing to check",
        output: `No citations found in ${args.file} (${outcome.skipped}).`,
      }
    }

    if (outcome.issues.length === 0) {
      return {
        title: "citecheck: clean",
        output: `All references in ${args.file} verified.`,
        metadata: { issues: 0 },
      }
    }

    return {
      title: `[citecheck] ${summarize(outcome.issues)}`,
      output: formatReport({
        file: args.file,
        ...(outcome.bibPath ? { bibPath: outcome.bibPath } : {}),
        issues: outcome.issues,
      }),
      metadata: { issues: outcome.issues.length },
    }
  },
})

export default {
  id: "citecheck",

  /** Plugin API v1. */
  async server(_input: unknown, options?: { citecheck?: unknown }) {
    const state = makeState(options?.citecheck)
    activeState = state

    return {
      tool: {
        citecheck_audit: auditTool,
      },

      "tool.execute.after": async (
        input: { tool: string; args?: unknown },
        output: { title?: string; output?: string; metadata?: unknown },
      ) => {
        if (!WRITE_TOOLS.has(input.tool)) return
        await annotate(input.args, output, state)
      },
    }
  },

  /** Plugin API v2. */
  async setup(ctx: {
    tool: { hook: (name: string, fn: (...a: any[]) => unknown) => void; transform: (fn: (editor: any) => void) => Promise<void> }
    options?: { citecheck?: unknown }
  }) {
    const state = makeState(ctx.options?.citecheck)
    activeState = state

    await ctx.tool.transform((editor) => {
      editor.add({ id: "citecheck_audit", ...auditTool })
    })

    ctx.tool.hook("execute.after", async (event: any) => {
      if (!WRITE_TOOLS.has(event.tool)) return
      if (event.status !== "completed") return
      await annotate(event.input, event.result, state)
    })
  },
}

export { parseBib, entryDoi, checkFile, formatReport, Verifier }
