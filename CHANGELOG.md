# Changelog

## Unreleased

## 1.1.1 - 2026-04-19
- Changed: removed dead legacy grep code and unused workspace context internals.
- Changed: shared common file-filtering schema fields across tool definitions.
- Fixed: `search_file_content` now reports invalid regex errors instead of returning false no-match results.
- Fixed: `search_file_content` now falls back to JS search when bundled `rg` cannot execute.
- Fixed: `read_many_files` now reports `max_output_bytes` truncation accurately when the first matching file exceeds the output budget.
- Fixed: binary files in `read_many_files` now count toward `max_files` and `max_output_bytes`.
- Added: regression tests for invalid regex handling, fallback search, binary file limits, and first-file truncation behavior.
- Changed: README parameter docs now match the current public API surface.

## 1.1.0 - 2026-02-19
- Deprecated: `ripgrep` tool name; use `search_file_content` (alias retained for backward compatibility).
- Fixed: `read_file` paged reads now report accurate total line counts in truncation metadata.
- Changed: unified path policy across tools; sensitive and git-ignored paths are blocked consistently by default.
- Added: `file_filtering_options` support for `read_file`, `write_file`, `replace`, `glob`, and `search_file_content`.
- Added: output controls: `list_directory.max_entries`, `glob.max_results`, `search_file_content.max_matches`, `search_file_content.max_output_bytes`, `read_many_files.max_files`, `read_many_files.max_output_bytes`.
- Changed: `search_file_content`, `list_directory`, and `read_many_files` return more compact text output for better token efficiency.
- Added: consistent `no_ignore` / `respect_git_ignore` override options across path-based tools.
- Added: optional unrestricted path mode via `CODE_TOOLS_MCP_ALLOW_ANY_PATHS=true` for environments where the caller already enforces filesystem sandboxing.
- Added: permission roots now sync from MCP Roots (`roots/list`) after initialization and refresh on `notifications/roots/list_changed`, with env/CLI roots retained as fallback.
