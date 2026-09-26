# Resource cache fixes — plan

**Status:** APPROVED (owner, 2026-09-26: "ok do the other fixes but dont add private repos … a warning should display if the cache is only caching the readme")

ADR: `docs/decisions/0082-resource-cache-keeps-document-structure.md`. Branch `oc/resource-cache-fixes`.
Every brief lives in `.oc-runs/resource-cache-fixes/`.

| # | Task | Main files |
|---|---|---|
| 1 | Pass fetched text through uncut; chunker drops `<head>`/`<svg>`, ignores `#` in code fences, clips heading segments; export `clipHeading` | core `resources.ts`, `chunker.ts`; daemon `resource-fetcher.ts` |
| 2 | Display caps (`search_sources` skip-not-stop, `read_chunk`, `open_resource`, `outline`, Sources line) + FTS stopwords | daemon `tools.ts`, `service.ts`; storage `resource-cache.ts` |
| 3 | Default GitHub selection: all markdown, priority order, 100-file cap | core `github.ts` |
| 4 | Refuse github.com for website/document/repository (save + refresh); correct the Cloudflare `challenge` hint | http `assistant.ts`, `catalog.ts`, `resource-failures.ts`; core `github.ts`; daemon `resource-refresh.ts` |
| 5 | README-only warning: freshness route reports token state; Resources page warning + badge; import-panel notice visible | http `assistant-resources-cache.ts`; dashboard `api/assistant.ts`, `pages/assistant-resources.tsx` |
| 6 | Migration 0048 clears cache validators so every document is re-fetched and re-chunked | `drizzle/`, storage test |

Global constraints are in every brief.
