# Learnings
- 2026-01-30: Gemini CLI tool parity: Gemini-style schemas + outputs, multi-root workspace support, binary reads in read_file/read_many_files.
- 2026-02-19: Centralizing path gating in one shared utility avoids policy drift between tools; ignore/sensitive checks must be applied both at target-path resolution and per-result filtering.
- 2026-02-19: For optional out-of-workspace access, default gitignore filtering to off unless explicitly requested; scanning ignore rules from arbitrary roots is expensive and can fail on non-repo paths.
- 2026-02-19: Permission roots should be sourced from MCP `roots/list` when available; env/CLI roots are a compatibility fallback, not the source of truth in rooted clients.
