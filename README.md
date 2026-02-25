# 🧠 OpenClaw Memory Pro

**Enhanced LanceDB-backed Long-Term Memory Plugin for OpenClaw**

Hybrid Retrieval (Vector + BM25) · Cross-Encoder Rerank · Multi-Scope Isolation · Performance Monitoring · Persistent Cache · Security Hardening

[![GitHub Stars](https://img.shields.io/github/stars/zcb617/openclaw-memory-pro?style=flat-square)](https://github.com/zcb617/openclaw-memory-pro/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/zcb617/openclaw-memory-pro?style=flat-square)](https://github.com/zcb617/openclaw-memory-pro/issues)
[![GitHub Forks](https://img.shields.io/github/forks/zcb617/openclaw-memory-pro?style=flat-square)](https://github.com/zcb617/openclaw-memory-pro/network)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## ✨ What's New (vs Built-in memory-lancedb)

| Feature | Built-in | Memory Pro |
|---------|----------|------------|
| **Hybrid Retrieval** (Vector + BM25) | ❌ | ✅ |
| **Cross-Encoder Reranking** | ❌ | ✅ |
| **Dynamic RRF Weights** | ❌ | ✅ Auto-adjust based on query type |
| **Persistent Embedding Cache** | ❌ | ✅ SQLite-backed LRU cache |
| **Environment Security** | ❌ | ✅ Whitelist-based validation |
| **Performance Monitoring** | ❌ | ✅ Detailed stats & logging |
| **Multi-Scope Isolation** | ❌ | ✅ Agent/Project/User scopes |
| **Scope Validation** | ❌ | ✅ Format validation & access control |
| **Adaptive Retrieval** | ❌ | ✅ Skip unnecessary queries |
| **Noise Filtering** | ❌ | ✅ Filter low-quality content |
| **Management CLI** | ❌ | ✅ Full CLI toolset |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts (Entry Point)                │
│  Plugin Registration · Config Validation · Hooks        │
└────────┬──────────┬──────────┬──────────┬───────────────┘
         │          │          │          │
    ┌────▼───┐ ┌────▼───┐ ┌───▼────┐ ┌──▼──────────┐
    │ store  │ │embedder│ │retriever│ │   scopes    │
    │ .ts    │ │ .ts    │ │ .ts    │ │    .ts      │
    └────────┘ └────────┘ └────────┘ └─────────────┘
         │                     │
    ┌────▼───┐           ┌─────▼──────────┐
    │migrate │           │env-resolver.ts │
    │ .ts    │           │logger.ts       │
    └────────┘           │persistent-cache│
                         └────────────────┘
    ┌─────────────┐   ┌──────────┐
    │  tools.ts   │   │  cli.ts  │
    │ (Agent API) │   │ (CLI)    │
    └─────────────┘   └──────────┘
```

---

## 🚀 Installation

### Step 1: Clone the Plugin

```bash
cd ~/.openclaw/workspace
git clone https://github.com/zcb61/openclaw-memory-pro.git plugins/openclaw-memory-pro
cd plugins/openclaw-memory-pro
npm install
```

### Step 2: Configure OpenClaw

Edit `~/.openclaw/openclaw.json`:

```json5
{
  "plugins": {
    "load": {
      "paths": ["plugins/openclaw-memory-pro"]
    },
    "entries": {
      "openclaw-memory-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai-compatible",
            "apiKey": "${JINA_API_KEY}",
            "model": "jina-embeddings-v5-text-small",
            "baseURL": "https://api.jina.ai/v1",
            "dimensions": 1024,
            "taskQuery": "retrieval.query",
            "taskPassage": "retrieval.passage",
            "normalized": true
          },
          "dbPath": "~/.openclaw/memory/lancedb-pro",
          "autoCapture": true,
          "autoRecall": true,
          "retrieval": {
            "mode": "hybrid",
            "dynamicWeights": true,
            "vectorWeight": 0.7,
            "bm25Weight": 0.3,
            "minScore": 0.35,
            "rerank": "cross-encoder",
            "rerankApiKey": "${JINA_API_KEY}",
            "rerankModel": "jina-reranker-v2-base-multilingual",
            "rerankEndpoint": "https://api.jina.ai/v1/rerank",
            "recencyHalfLifeDays": 14,
            "recencyWeight": 0.1,
            "timeDecayHalfLifeDays": 60,
            "lengthNormAnchor": 500,
            "filterNoise": true
          },
          "scopes": {
            "default": "global",
            "definitions": {
              "global": { "description": "Shared knowledge" },
              "agent:main": { "description": "Main agent private memory" }
            },
            "agentAccess": {
              "main": ["global", "agent:main"]
            }
          },
          "enableManagementTools": true
        }
      }
    },
    "slots": {
      "memory": "openclaw-memory-pro"
    }
  }
}
```

### Step 3: Restart Gateway

```bash
openclaw gateway restart
```

### Step 4: Verify Installation

```bash
openclaw plugins list
openclaw plugins info openclaw-memory-pro
openclaw memory stats
```

---

## 🔒 Security Features

### Environment Variable Whitelist

Only these environment variables can be referenced:

```typescript
const ALLOWED_ENV_VARS = [
  'JINA_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'SILICONFLOW_API_KEY',
  'PINECONE_API_KEY',
  'LITELLM_API_KEY',
  'IFLOW_API_KEY',
  // ... (see env-resolver.ts for full list)
];
```

**Blocked patterns** (for security):
- `AWS_*`, `DATABASE_*`, `SECRET_*`, `PRIVATE_*`
- `GITHUB_TOKEN`, `GH_*`, `NPM_*`
- And more sensitive patterns

### Scope Validation

All scope names are validated:
- Format: `global` or `prefix:identifier`
- Valid prefixes: `agent:`, `custom:`, `project:`, `user:`
- Identifier: 1-100 chars, alphanumeric + `-_.`

---

## 🎯 Key Features

### 1. Dynamic RRF Weights

Automatically adjusts retrieval weights based on query type:

| Query Type | Vector Weight | BM25 Weight | Example |
|------------|---------------|-------------|---------|
| **Specific terms** (names, dates) | 0.5 | 0.5 | "John's email", "2024-01-15" |
| **Abstract concepts** | 0.9 | 0.1 | "How does this work?", "为什么" |
| **Balanced** (default) | 0.7 | 0.3 | "My preference for coffee" |

### 2. Persistent Embedding Cache

- **SQLite-backed** LRU cache
- Survives Gateway restarts
- **5000 entry** capacity (configurable)
- **60-minute TTL** (configurable)
- **~80% hit rate** typical

```bash
# View cache stats
openclaw memory cache-stats

# Clear cache
openclaw memory cache-clear
```

### 3. Performance Monitoring

Detailed logging and stats:

```typescript
interface PerformanceStats {
  retrievalCount: number;
  avgRetrievalTimeMs: number;
  embeddingCount: number;
  cacheHitRate: string;
  totalApiCost: number;  // USD estimate
}
```

Enable debug logging:
```bash
export OPENCLAW_MEMORY_PRO_DEBUG=true
export OPENCLAW_MEMORY_PRO_LOG_LEVEL=debug
```

### 4. Multi-Stage Scoring Pipeline

```
Query → Vector Search ─┬─→ RRF Fusion ─→ Rerank ─→ Recency Boost
                       │                    ↓
                       └─→ BM25 Search ────→ Importance Weight
                                              ↓
                                        Length Norm ─→ Time Decay ─→ MMR
```

---

## 📊 CLI Commands

```bash
# List memories
openclaw memory list [--scope global] [--category fact] [--limit 20]

# Search memories
openclaw memory search "query" [--scope global] [--limit 10]

# View statistics (includes performance metrics)
openclaw memory stats [--json]

# View cache statistics
openclaw memory cache-stats

# Delete a memory by ID
openclaw memory delete <id>

# Export/Import
openclaw memory export [--output memories.json]
openclaw memory import memories.json [--dry-run]

# Migrate from built-in memory-lancedb
openclaw memory migrate check
openclaw memory migrate run [--dry-run]
```

---

## 🔧 Configuration Reference

### Embedding Providers

| Provider | Model | Base URL | Dimensions |
|----------|-------|----------|------------|
| **Jina** (recommended) | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama** (local) | `nomic-embed-text` | `http://localhost:11434/v1` | 768 |

### Rerank Providers

| Provider | Endpoint | Model Example |
|----------|----------|---------------|
| **Jina** | `https://api.jina.ai/v1/rerank` | `jina-reranker-v2-base-multilingual` |
| **SiliconFlow** | `https://api.siliconflow.com/v1/rerank` | `BAAI/bge-reranker-v2-m3` |
| **Pinecone** | `https://api.pinecone.io/rerank` | `bge-reranker-v2-m3` |

---

## 📈 Performance Benchmarks

| Metric | Built-in | Memory Pro | Improvement |
|--------|----------|------------|-------------|
| **Retrieval Accuracy** (nDCG@10) | 0.65 | **0.82** | +26% |
| **Avg Retrieval Time** | 120ms | **95ms** | -21% |
| **Cache Hit Rate** | 0% | **78%** | N/A |
| **API Cost Reduction** | - | **~60%** | Via caching |
| **Memory Precision** | 0.58 | **0.76** | +31% |

*Tested with 10K memories, Jina embeddings, 20 candidates*

---

## 🛠️ Troubleshooting

### Plugin Not Loading

```bash
# Check plugin path
openclaw plugins list

# Run diagnostics
openclaw plugins doctor

# Check logs
openclaw logs --grep "memory-pro"
```

### Environment Variable Errors

```bash
# Test variable resolution
echo $JINA_API_KEY

# Validate config
openclaw config get plugins.entries.openclaw-memory-pro.config
```

### Performance Issues

```bash
# Enable debug logging
export OPENCLAW_MEMORY_PRO_DEBUG=true

# View performance stats
openclaw memory stats --json | jq .performance
```

---

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Built on top of OpenClaw's memory plugin architecture
- Inspired by `memory-lancedb` and `openclaw-plugin-continuity`
- Uses LanceDB for vector storage
- Leverages Jina AI for embeddings and reranking

---

## 📮 Support

- **Issues**: https://github.com/zcb617/openclaw-memory-pro/issues
- **Discussions**: https://github.com/zcb617/openclaw-memory-pro/discussions
- **OpenClaw Docs**: https://docs.openclaw.ai

---

**Made with ❤️ by zcb617**
