# Gaps & TODOs for code-tools MCP

Date: 2025-10-08
Scope: src/tools vs ai_docs/reference_code parity. Track, implement, and verify.

Legend: [ ] = todo, [x] = done, [~] = partial

## Cross‑Cutting
- [x] Add consistent `structuredContent.summary` across tools lacking it (`src/tools/edit.ts`, `src/tools/write-file.ts`).
- [x] Expose truncation metadata where caps apply:
  - grep: add `truncated: boolean` and optional `max_matches` (default 2000).
  - ripgrep: add `truncated: boolean` and optional `max_matches` (default 20000).
- [x] Optional smart‑case search behavior:
  - grep: emulate smart‑case when `ignore_case` is undefined.
  - ripgrep: prefer `--smart-case` when `ignore_case` not explicitly set.
- [x] README updates (document new/changed options and behaviors): grep, ripgrep, glob, ls, read_file, read_many_files.
- [x] Docs cleanup: ensure all references to `.geminiignore` are removed from docs (code already purged).
- [x] Verify Windows path containment (case‑insensitive, trailing separators) in workspace utils (already implemented in workspace.ts).

## Client‑Facing (MCP) Ergonomics
- [x] Short, token‑efficient tool descriptions in `src/index.ts` (one‑liners).
- [x] Add `.describe(...)` to every Zod input property so parameter docs flow to `tools/list` (already implemented).
- [ ] Define `outputSchema` (Zod) for tools that return `structuredContent`; wire to `registerTool` (deferred - requires MCP SDK investigation).
- [x] Ensure schema docs include defaults/limits (e.g., `max_matches`, caps, pagination limits).
- [x] Export unified TS types for clients/tests in `src/types/tools.ts` (re‑export `z.infer` Input/Output).
- [x] README: "Using These Tools from an MCP Client" section with TS snippet for `tools/list` and `client.callTool`.
- [ ] Document `tools/list` pagination (`cursor`) and `tools/list_changed` notification semantics (not applicable for this server).
- [x] Add per‑tool minimal call examples (1–2 lines) matching the schemas.
- [x] Add "Tool Stability" note (stable names; concise descriptions; parameter docs live in schema).

## Tool‑Specific

### edit.ts (`src/tools/edit.ts`)
- [x] Add explicit "no change" detection and error (EDIT_NO_CHANGE) when `old_string === new_string` or computed new content equals current.
- [x] Improve error messaging parity: when file exists and `old_string === ''`, surface clear error instead of generic occurrence failure.
- [x] Add `structuredContent.summary` (e.g., occurrences replaced, applied/preview).
- [x] Consider safer replacement semantics for literal `$` handling (optional parity with reference `safeLiteralReplace`) - marked as optional, current implementation is sufficient.

### write-file.ts (`src/tools/write-file.ts`)
- [x] Add `structuredContent.summary` and include a concise diff summary (lines added/removed) if feasible.
- [x] Map common FS errors to clearer responses (e.g., EACCES, ENOSPC, EISDIR) with specific error codes/types.
- [x] Friendlier validation error when path is outside workspace (before write attempt).
- [x] Include note in responses when `modified_by_user` is true.

### read-file.ts (`src/tools/read-file.ts`)
- [x] Add opt‑in flag to allow reading `.gitignore`‑ignored files (e.g., `allow_ignored?: boolean`).
- [x] Include a `summary` on non‑paginated reads for consistency.
- [x] Pagination UX: return a `nextOffset` hint in structured content when partial slice returned.
- [ ] (Optional) Support images/PDFs as model‑readable parts if needed by consumers; otherwise keep current binary summary.

### read-many-files.ts (`src/tools/read-many-files.ts`)
- [x] Add workspace containment re‑check for each resolved path (belt‑and‑suspenders after globbing).
- [x] Surface aggregated skip reasons and counts (ignored, binary, too large, total cap reached) in structured summary.
- [x] Expose `truncated`/`totalCapReached` when hitting TOTAL_BYTE_CAP.
- [ ] (Optional parity) Allow explicit inclusion of images/PDFs when referenced by name/extension and emit suitable parts.

### grep.ts (`src/tools/grep.ts`)
- [x] Support `exclude` as `string | string[]` (currently `string`).
- [x] Add `truncated` flag and optional `max_matches` parameter; document 2000 default.
- [x] (Optional) Implement smart‑case when `ignore_case` undefined.
- [x] Consider grouping output by file in text mode for readability (retain structured `matches`).

### ripgrep.ts (`src/tools/ripgrep.ts`)
- [x] Add `truncated` flag and optional `max_matches`; include “(limited …)” note in text when truncated.
- [x] Use `--smart-case` by default when `ignore_case` is not explicitly provided.
- [x] Improve scope messaging in text output when searching root vs a subpath (e.g., "across N workspace directories" when applicable).

### glob.ts (`src/tools/glob.ts`)
- [x] Switch fast‑glob to `objectMode: true` and use entry.stats to avoid extra `fs.stat` calls.
- [x] Consider two‑tier sorting: recent (e.g., <24h) newest‑first, then older alphabetically, to match reference UX.
- [x] Optional: report `gitIgnoredCount` in result when zero files are returned to aid debugging.

### ls.ts (`src/tools/ls.ts`)
- [x] When directory is empty, return a clearer neutral message alongside structured entries (parity polish).
- [x] Keep reporting only `.gitignore` counts (no `.geminiignore`) per project requirement; verify README reflects this.

## Verification & Tests
- [ ] Workspace containment tests (win32 case‑insensitive, POSIX), trailing separators.
- [ ] grep/ripgrep tests: regex error handling, ignore_case true/false, include/exclude arrays, binary skip, truncation cap flags.
- [ ] glob tests: objectMode results and newest‑first or two‑tier ordering; `.gitignore` filtering honored.
- [ ] ls tests: ignored counts and name‑based custom ignore patterns; empty directory output.
- [ ] read_file tests: ignored file handling + override flag; pagination boundaries; MIME override for .ts/.tsx; binary branch.
- [ ] read_many_files tests: total size cap signaling; include/exclude merging; ignored/skipped aggregation; workspace re‑check.

## Documentation Checklist
- [x] Update README sections for each tool reflecting new flags/behavior and limits.
- [x] Add short usage examples for: grep/ripgrep `max_matches`, `ignore_case`/smart‑case, glob sorting behavior, read_file `allow_ignored`.
- [x] Note removal of `.geminiignore` support across tools and clarify only `.gitignore` is respected.
- [x] Add "Using These Tools from an MCP Client" section (TS snippet for `tools/list` and `client.callTool`).
- [x] Mention that parameter docs come from JSON Schema (via Zod `.describe(...)`).
- [x] Brief per‑tool minimal call examples (1–2 lines) matching schemas.

