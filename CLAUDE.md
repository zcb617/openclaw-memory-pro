# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (outputs to ./dist)
npm test             # Run tests with vitest
npm run lint         # Run ESLint
```

## Architecture Overview

This is an OpenClaw plugin that provides enhanced long-term memory with LanceDB storage and hybrid retrieval (Vector + BM25).

### Core Modules

```
index.ts → Plugin entry point, lifecycle hooks (before_agent_start, agent_end, command:new)
   │
   ├─ src/store.ts          → LanceDB storage layer (vector + FTS index)
   ├─ src/embedder.ts       → Embedding abstraction (OpenAI-compatible API)
   ├─ src/retriever.ts      → Hybrid retrieval pipeline with reranking
   ├─ src/scopes.ts         → Multi-scope access control
   ├─ src/tools.ts          → Agent tools (memory_recall, memory_store, memory_forget)
   │
   ├─ src/persistent-cache.ts → SQLite LRU cache for embeddings
   ├─ src/env-resolver.ts     → Environment variable whitelist security
   ├─ src/logger.ts           → Structured logging & performance monitoring
   ├─ src/noise-filter.ts     → Filter low-quality memories
   └─ src/adaptive-retrieval.ts → Skip unnecessary retrieval
```

### Retrieval Pipeline

```
Query → [Vector Search + BM25] → RRF Fusion → Cross-Encoder Rerank
        → Recency Boost → Importance Weight → Length Norm → Time Decay → MMR
```

### Key Configuration (openclaw.plugin.json)

- `embedding`: Provider config (Jina/OpenAI/Gemini/Ollama)
- `retrieval.mode`: "hybrid" or "vector"
- `retrieval.dynamicWeights`: Auto-adjust Vector/BM25 weights by query type
- `scopes`: Multi-scope isolation with agent access control

## Important Notes

- **No `agents.memorySearch` required**: Plugin manages its own embedding config via `plugins.entries.openclaw-memory-pro.config`
- **Environment variables**: Use whitelist in `src/env-resolver.ts` - blocked patterns include `AWS_*`, `SECRET_*`, `GITHUB_TOKEN`
- **Scope format**: `global` or `prefix:identifier` (valid prefixes: `agent:`, `custom:`, `project:`, `user:`)
