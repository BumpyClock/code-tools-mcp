# Gaps & TODOs for code-tools MCP

Date: 2025-10-08
Scope: src/tools vs ai_docs/reference_code parity. Track, implement, and verify.

Legend: [ ] = todo, [x] = done, [~] = partial

## Cross‑Cutting
- [ ] Add consistent `structuredContent.summary` across tools lacking it (`src/tools/edit.ts`, `src/tools/write-file.ts`).
- [ ] Expose truncation metadata where caps apply:
  - grep: add `truncated: boolean` and optional `max_matches` (default 2000).
  - ripgrep: add `truncated: boolean` and optional `max_matches` (default 20000).
- [ ] Optional smart‑case search behavior:
  - grep: emulate smart‑case when `ignore_case` is undefined.
  - ripgrep: prefer `--smart-case` when `ignore_case` not explicitly set.
- [ ] README updates (document new/changed options and behaviors): grep, ripgrep, glob, ls, read_file, read_many_files.
- [ ] Docs cleanup: ensure all references to `.geminiignore` are removed from docs (code already purged).
- [ ] Verify Windows path containment (case‑insensitive, trailing separators) in workspace utils.

## Tool‑Specific

### edit.ts (`src/tools/edit.ts`)
- [ ] Add explicit "no change" detection and error (EDIT_NO_CHANGE) when `old_string === new_string` or computed new content equals current.
- [ ] Improve error messaging parity: when file exists and `old_string === ''`, surface clear error instead of generic occurrence failure.
- [ ] Add `structuredContent.summary` (e.g., occurrences replaced, applied/preview).
- [ ] Consider safer replacement semantics for literal `$` handling (optional parity with reference `safeLiteralReplace`).

### write-file.ts (`src/tools/write-file.ts`)
- [ ] Add `structuredContent.summary` and include a concise diff summary (lines added/removed) if feasible.
- [ ] Map common FS errors to clearer responses (e.g., EACCES, ENOSPC, EISDIR) with specific error codes/types.
- [ ] Friendlier validation error when path is outside workspace (before write attempt).
- [ ] Include note in responses when `modified_by_user` is true.

### read-file.ts (`src/tools/read-file.ts`)
- [ ] Add opt‑in flag to allow reading `.gitignore`‑ignored files (e.g., `allow_ignored?: boolean`).
- [ ] Include a `summary` on non‑paginated reads for consistency.
- [ ] Pagination UX: return a `nextOffset` hint in structured content when partial slice returned.
- [ ] (Optional) Support images/PDFs as model‑readable parts if needed by consumers; otherwise keep current binary summary.

### read-many-files.ts (`src/tools/read-many-files.ts`)
- [ ] Add workspace containment re‑check for each resolved path (belt‑and‑suspenders after globbing).
- [ ] Surface aggregated skip reasons and counts (ignored, binary, too large, total cap reached) in structured summary.
- [ ] Expose `truncated`/`totalCapReached` when hitting TOTAL_BYTE_CAP.
- [ ] (Optional parity) Allow explicit inclusion of images/PDFs when referenced by name/extension and emit suitable parts.

### grep.ts (`src/tools/grep.ts`)
- [ ] Support `exclude` as `string | string[]` (currently `string`).
- [ ] Add `truncated` flag and optional `max_matches` parameter; document 2000 default.
- [ ] (Optional) Implement smart‑case when `ignore_case` undefined.
- [ ] Consider grouping output by file in text mode for readability (retain structured `matches`).

### ripgrep.ts (`src/tools/ripgrep.ts`)
- [ ] Add `truncated` flag and optional `max_matches`; include “(limited …)” note in text when truncated.
- [ ] Use `--smart-case` by default when `ignore_case` is not explicitly provided.
- [ ] Improve scope messaging in text output when searching root vs a subpath (e.g., "across N workspace directories" when applicable).

### glob.ts (`src/tools/glob.ts`)
- [ ] Switch fast‑glob to `objectMode: true` and use entry.stats to avoid extra `fs.stat` calls.
- [ ] Consider two‑tier sorting: recent (e.g., <24h) newest‑first, then older alphabetically, to match reference UX.
- [ ] Optional: report `gitIgnoredCount` in result when zero files are returned to aid debugging.

### ls.ts (`src/tools/ls.ts`)
- [ ] When directory is empty, return a clearer neutral message alongside structured entries (parity polish).
- [ ] Keep reporting only `.gitignore` counts (no `.geminiignore`) per project requirement; verify README reflects this.

## Verification & Tests
- [ ] Workspace containment tests (win32 case‑insensitive, POSIX), trailing separators.
- [ ] grep/ripgrep tests: regex error handling, ignore_case true/false, include/exclude arrays, binary skip, truncation cap flags.
- [ ] glob tests: objectMode results and newest‑first or two‑tier ordering; `.gitignore` filtering honored.
- [ ] ls tests: ignored counts and name‑based custom ignore patterns; empty directory output.
- [ ] read_file tests: ignored file handling + override flag; pagination boundaries; MIME override for .ts/.tsx; binary branch.
- [ ] read_many_files tests: total size cap signaling; include/exclude merging; ignored/skipped aggregation; workspace re‑check.

## Documentation Checklist
- [ ] Update README sections for each tool reflecting new flags/behavior and limits.
- [ ] Add short usage examples for: grep/ripgrep `max_matches`, `ignore_case`/smart‑case, glob sorting behavior, read_file `allow_ignored`.
- [ ] Note removal of `.geminiignore` support across tools and clarify only `.gitignore` is respected.

