# opencode-citecheck

[![npm version](https://img.shields.io/npm/v/opencode-citecheck.svg)](https://www.npmjs.com/package/opencode-citecheck)
[![CI](https://github.com/Xtardy/opencode-citecheck/actions/workflows/ci.yml/badge.svg)](https://github.com/Xtardy/opencode-citecheck/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Catch fabricated, unresolved and retracted references inside the OpenCode agent loop — before they reach your paper.**

AI agents write citations that look plausible and do not exist. `opencode-citecheck` checks every `\cite{key}` and every DOI the moment the agent writes the file, and reports the problem back into the same turn, so the agent can fix it itself.

```
← Write paper.tex
[citecheck] 2 reference problems found in paper.tex.
Bibliography: refs.bib
  - ghost2024fake: DOI not found in Crossref, OpenAlex or DataCite
  - wakefield1998: retracted (Crossref / Retraction Watch); notice DOI 10.1016/s0140-6736(10)60175-4
```

No API keys. No hosted service. No account.

Not using OpenCode? The same checks run from the command line, for a single file, a whole folder or CI:

```bash
npx opencode-citecheck check paper.tex
```

See [CLI, for CI](#cli-for-ci).

![opencode-citecheck flagging a DOI that does not exist](https://raw.githubusercontent.com/Xtardy/opencode-citecheck/main/docs/demo.gif)

And inside OpenCode, with a real agent (Sisyphus on DeepSeek V4.1 Flash Free, plugin 0.2.2, sped up 1.5x):

![An OpenCode agent writing a bibliography, getting a wrong arXiv ID flagged, and fixing it](https://raw.githubusercontent.com/Xtardy/opencode-citecheck/main/docs/opencode-demo.gif)

The wrong citation is staged: I put the bad arXiv ID (2005.11499, an unrelated statistics paper) in the prompt to simulate a hallucinated reference. The agent, the tool calls and the fix are real and unedited, apart from the speed-up and the cut of OpenCode's start-up time.

---

## Why this exists

An agent asked to write a literature review will happily produce `\cite{smith2024quantum}`. The key is well-formed, the sentence reads well, and the reference is imaginary.

Existing tools check references at **save time** (a VS Code `.bib` linter) or at **CI time** (a `bibcheck` run in a pipeline). Neither helps while the agent is still writing — by the time CI catches it, the fabricated reference has already been read, cited, and built upon.

OpenCode exposes a hook that runs after a tool call and lets a plugin rewrite the tool result. That result is part of the model's context. This plugin uses it to put the warning in front of the model *while it can still act on it*.

---

## What it checks

| Check | How |
| --- | --- |
| Cited key missing from the bibliography | parse `\cite` / `[@key]`, compare against the `.bib` |
| DOI does not exist | Crossref → OpenAlex → DataCite |
| DOI points at a different paper | title comparison against the registry record |
| Reference has been retracted | Crossref `updated-by`, sourced from Retraction Watch |
| arXiv entry without a DOI field | the arXiv ID (`eprint`, `arXiv:...` in `journal`, or an arxiv.org URL) is checked through the DOI arXiv registers for every paper, `10.48550/arXiv.<id>` |
| Entry has no DOI | optional, off by default (many valid entries lack one) |

Supported syntax:

- LaTeX: `\cite`, `\citep`, `\citet`, `\citeauthor`, `\parencite`, `\textcite`, `\autocite`, `\footcite`, `\nocite{*}`, with optional `[...]` arguments
- Pandoc / Quarto / R Markdown: `[@key]`, `[@a; @b]`, `@key`

Files inspected: `.tex`, `.latex`, `.ltx`, `.md`, `.markdown`, `.mdx`, `.rmd`, `.qmd`, `.ipynb`, `.bib`.

---

## Install

```bash
opencode plugin opencode-citecheck
```

This adds the package to the `.opencode/opencode.json` of the current project. Add `-g` to put it in your global config instead.

You can also edit the config by hand:

```json
{
  "plugin": ["opencode-citecheck"]
}
```

Then just write. Nothing else to configure.

---

## Status

Early, version 0.1.x.

- Install checked on OpenCode 1.18.35. The hook itself was tested end to end on 1.18.31.
- Needs OpenCode 1.18.29 or newer.
- OpenCode 2.x: the package also exports `setup()` for plugin API v2, written against the published typings. I have not run it on a live v2, so if it breaks there, please open an issue.
- The only network calls go to Crossref, OpenAlex and DataCite, with the DOIs found in your bibliography. The plugin does not edit your files; it only adds text to the tool result the model sees.

---

## The `citecheck_audit` tool

Ask the agent to audit a bibliography without waiting for a write:

> *"Audit references.bib and tell me if anything is retracted."*

The agent calls `citecheck_audit` and gets the same report. Useful before submitting, or when reviewing someone else's bibliography.

---

## Configuration

All settings are optional.

```json
{
  "plugin": ["opencode-citecheck"],
  "citecheck": {
    "mailto": "you@example.com",
    "reportMissingDoi": false,
    "concurrency": 6
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `checkBibFiles` | `true` | Verify `.bib` entries on write |
| `checkCiteKeys` | `true` | Verify cite keys in documents |
| `reportMissingDoi` | `false` | Also report entries with no DOI |
| `timeoutMs` | `8000` | Per-request timeout |
| `concurrency` | `6` | Max parallel registry requests |
| `cacheTtlMs` | `21600000` (6h) | Result cache lifetime |
| `mailto` | — | Joins the Crossref/OpenAlex polite pool |
| `offline` | `false` | Disable all network access |
| `bibSearchDepth` | `3` | Directories to walk up looking for a `.bib` |

Every option has an environment variable equivalent: `CITECHECK_ENABLED`, `CITECHECK_MAILTO`, `CITECHECK_OFFLINE`, `CITECHECK_TIMEOUT_MS`, `CITECHECK_CONCURRENCY`, `CITECHECK_CACHE_TTL_MS`, `CITECHECK_CHECK_BIB`, `CITECHECK_CHECK_CITES`, `CITECHECK_REPORT_MISSING_DOI`.

---

## CLI, for CI

The package ships a standalone CLI so you can gate a pull request on reference integrity.

```bash
npx opencode-citecheck check paper.tex
npx opencode-citecheck check . --fail-on retracted
npx opencode-citecheck check refs.bib --json
```

| Exit code | Meaning |
| --- | --- |
| `0` | No problems (or nothing checkable) |
| `1` | Reference problems found (per `--fail-on`) |
| `2` | Usage error, **or** verification was inconclusive because a registry was unreachable |

Exit code `2` deliberately does not mean "bad reference". A network outage must not fail a build as if the bibliography were wrong — but it must not pass silently either. `--offline` reports unchecked entries on stdout and exits `0`, since nothing was claimed about them.

`--fail-on any` (default) fails on any finding. `--fail-on retracted` only fails on retractions, which is a good default for a paper you are about to submit: a missing key is a typo, a retracted citation is a problem.

### Behind a proxy

Node does not honour `HTTP_PROXY` by default. On Node 20.13+ set `NODE_USE_ENV_PROXY=1` and the CLI will use your proxy. (The OpenCode plugin does not need this: it runs under Bun, which reads the proxy variables itself.)

### GitHub Actions

```yaml
- name: Check references
  run: npx opencode-citecheck check . --fail-on retracted --mailto ${{ secrets.CONTACT_EMAIL }}
```

---

## Honest limitations

This is a signal, not a gate.

**It does not override you.** If you tell the agent "write exactly this line" and that line cites a fabricated paper, the agent will see the warning and may keep the citation, because your instruction outranks the plugin. That is the correct behaviour, and it means the plugin protects against references the *agent* invents, not against references *you* insist on.

**It verifies existence, not support.** A DOI that resolves proves the paper exists. It does not prove the paper says what the sentence claims. Claim-level checking is a separate, much harder problem, and this plugin deliberately does not pretend to solve it.

**It needs a bibliography.** A cite key is a local identifier. Without a `.bib` file the plugin can only tell you the key is unresolved — it cannot tell you what the key was supposed to mean. If several `.bib` files are present and the document does not declare one, the plugin reports the ambiguity rather than guessing.

**Registry coverage is not universal.** Crossref covers most DOIs; OpenAlex and DataCite fill some gaps. A DOI registered somewhere else will be reported as unresolved. Very new papers may not be indexed yet.

**Retraction data has latency.** Crossref's `updated-by` is fed by Retraction Watch and is not instantaneous.

---

## How it works

```
agent writes paper.tex
        │
        ▼
tool.execute.after hook fires
        │
        ├─ parse \cite keys from the written content
        ├─ resolve the nearest .bib (declared → conventional → single → walk up)
        ├─ map key → entry → DOI
        ├─ verify DOIs in parallel (Crossref → OpenAlex → DataCite)
        │     with a 6h TTL cache and bounded concurrency
        └─ append the report to the tool result
        │
        ▼
the model sees the warning in the same turn and can fix the file
```

Latency measured on 30 entries: **3.97 s sequential → 443 ms with bounded parallelism**. Cached repeats are effectively free.

No sandboxing, no background daemon, no writes outside the plugin's own cache. The plugin only reads files you are already editing.

---

## What it deliberately does not do

- **Format references.** `citeproc-js` already does CSL, correctly.
- **Convert DOIs to BibTeX.** `doi.org` content negotiation already does this.
- **Scrape Google Scholar.** There is no API, and the terms of service prohibit it.
- **Touch Sci-Hub.** Legal risk, no benefit here.
- **Replace Zotero.** If you want a reference manager, use one; this checks what the agent wrote.

---

## Development

```bash
npm install
npm test          # offline, no network
npm run typecheck
npm run build
```

Tests stub `fetch`; the suite never touches the network. The test suite runs TypeScript directly through `--experimental-strip-types`, so it needs Node 22.6+. The published package itself is plain JavaScript and runs on Node 20.

---

## License

MIT.
