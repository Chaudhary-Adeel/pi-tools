# Context Virtual Memory (CVM)

pi-tools' layered context engine. Goal: deliver the **smallest complete
context** required for correct reasoning — never the smallest possible
prompt. Source code is never summarized in place of itself; savings come from
not re-sending, not re-downloading, not re-parsing, and not over-retrieving.

## Core guarantees

- **Never download identical content twice** — HTTP cache with ETag /
  Last-Modified revalidation; bodies content-addressed in cold storage.
- **Never parse identical content twice** — symbol index invalidated by
  `mtime+size`, then by content fingerprint; unchanged files cost one `stat()`.
- **Never index identical content twice** — content-addressed everything.
- **Never resend identical context** — session delta ledger: repeat reads
  return an `[CVM] unchanged` stub; changed files return a compact diff.
  Every stub carries a `force_full: true` escape hatch for post-compaction
  recovery, so reasoning quality is never starved.
- **Never retrieve whole files when symbols suffice** — `context_resolve`
  returns a symbol's exact source + dependency signatures + callers.
- **Confidence over compression** — every resolve scores dependency/caller
  coverage; below threshold it auto-expands (signatures → bodies) and
  rescores.

## Architecture

```
LLM ⇄ tools (read_file, web_fetch, github_explore, context_resolve)
          │
          ▼
   ┌─ Hot memory ───── in-process LRU+TTL (O(1), byte-budgeted)      src/cvm/hot-cache.ts
   ├─ Warm memory ──── .pi/cvm/cvm.db via node:sqlite (WAL,          src/cvm/warm-store.ts
   │                   transactions; in-memory fallback)
   ├─ Cold storage ─── .pi/cvm/objects/ brotli, content-addressed    src/cvm/cold-store.ts
   ├─ Symbol memory ── incremental index: symbols + refs             src/cvm/symbols.ts
   ├─ Context engine ─ symbol-level retrieval + confidence           src/cvm/context.ts
   ├─ Delta mode ───── session ledger: stubs + compact diffs         src/cvm/delta.ts
   ├─ HTTP cache ───── fresh / revalidated (304) / network           src/cvm/http-cache.ts
   └─ Metrics ──────── tokens saved, hit ratios (/cvm)               src/cvm/metrics.ts
```

The warm store persists across sessions; the delta ledger is deliberately
session-scoped (a fresh context has seen nothing).

## Status vs. the full vNext spec

| Spec area | Status |
|---|---|
| Hot / warm / cold tiers | ✅ implemented (node:sqlite + brotli CAS, zero deps) |
| Semantic fingerprints (SHA-256, reuse) | ✅ implemented |
| Incremental symbol memory + instant lookup | ✅ implemented (heuristic extractor, 20+ languages by extension) |
| AST-aware retrieval (symbol + deps + callers, never whole files) | ✅ implemented (`context_resolve`) |
| Context Confidence Engine with auto-expansion | ✅ implemented |
| Delta mode (unchanged stubs, compact diffs) | ✅ implemented for `read_file` / `web_fetch` |
| HTTP cache (ETag, Last-Modified, no-store, dedup) | ✅ implemented; wired into `web_fetch` + `github_explore` |
| Observability (`/cvm`, tokens saved, hit ratios) | ✅ implemented |
| Tree-sitter ASTs, partial reparse | 🔜 roadmap — needs a native dep; current extractor is regex+indentation |
| Embeddings / semantic similarity ranking | 🔜 roadmap — needs a model or API |
| Hierarchical summary cache | 🔜 roadmap (warm `kv` space is ready for it) |
| Repository / conversation knowledge graphs | 🔜 roadmap (refs table is the seed) |
| Git object cache, sparse checkout | 🔜 roadmap |
| Prompt budget manager, semantic compression | 🔜 roadmap |

## Measured on this repository

Initial index: 338 symbols / 57 files in ~330 ms. Warm reindex: 0 parsed,
57 reused, ~11 ms. Symbol lookup: <1 ms. A real `context_resolve` returned
~193 tokens at 85% confidence vs ~3,600 tokens of whole involved files.
HTTP cache verified end-to-end: network → fresh (zero requests) →
304-revalidated (zero download). Delta verified: full → stub → diff.

## Operations

- `/cvm` — metrics, index size, storage backend, cold-object stats
- `/cvm index` — force a reindex now (otherwise incremental + debounced)
- `context_resolve` tool — symbol-level retrieval with confidence
- `force_full: true` on `read_file` / `web_fetch` — bypass delta stubs after
  compaction
- Storage lives in `.pi/cvm/` (gitignored); safe to delete any time — it
  rebuilds incrementally.
