/**
 * Enhanced Hybrid Retrieval System
 * - Dynamic RRF weight adjustment based on query type
 * - Performance monitoring and logging
 * - Multi-stage scoring pipeline
 */

import type { MemoryStore, MemorySearchResult } from "./store.js";
import type { Embedder } from "./embedder.js";
import { filterNoise } from "./noise-filter.js";
import { getLogger } from "./logger.js";

// ============================================================================
// Types & Configuration
// ============================================================================

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  vectorWeight: number;
  bm25Weight: number;
  minScore: number;
  rerank: "cross-encoder" | "lightweight" | "none";
  candidatePoolSize: number;
  recencyHalfLifeDays: number;
  recencyWeight: number;
  filterNoise: boolean;
  rerankApiKey?: string;
  rerankModel?: string;
  rerankEndpoint?: string;
  rerankProvider?: "jina" | "siliconflow" | "pinecone";
  lengthNormAnchor: number;
  hardMinScore: number;
  timeDecayHalfLifeDays: number;
  /** Enable dynamic RRF weight adjustment (default: true) */
  dynamicWeights: boolean;
}

export interface RetrievalContext {
  query: string;
  limit: number;
  scopeFilter?: string[];
  category?: string;
}

export interface RetrievalResult extends MemorySearchResult {
  sources: {
    vector?: { score: number; rank: number };
    bm25?: { score: number; rank: number };
    fused?: { score: number };
    reranked?: { score: number };
  };
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  minScore: 0.3,
  rerank: "cross-encoder",
  candidatePoolSize: 20,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.10,
  filterNoise: true,
  rerankModel: "jina-reranker-v2-base-multilingual",
  rerankEndpoint: "https://api.jina.ai/v1/rerank",
  lengthNormAnchor: 500,
  hardMinScore: 0.35,
  timeDecayHalfLifeDays: 60,
  dynamicWeights: true,
};

// ============================================================================
// Query Type Detection for Dynamic Weights
// ============================================================================

/**
 * Analyze query to determine optimal RRF weights
 * Returns { vectorWeight, bm25Weight } based on query characteristics
 */
export function computeDynamicWeights(query: string): { vectorWeight: number; bm25Weight: number } {
  // Check for specific keywords (names, dates, technical terms) → higher BM25 weight
  const hasSpecificTerms = 
    /[A-Z][a-z]+/.test(query) ||  // Capitalized words (names)
    /\d{4}-\d{2}-\d{2}/.test(query) ||  // Dates
    /@\w+/.test(query) ||  // Email-like
    /#?\d+/.test(query) ||  // Numbers/IDs
    /https?:\/\//.test(query) ||  // URLs
    /[\/\\]/.test(query);  // Paths

  if (hasSpecificTerms) {
    return { vectorWeight: 0.5, bm25Weight: 0.5 };
  }

  // Check for abstract/semantic queries → higher vector weight
  const hasAbstractTerms = 
    /\b(how|why|what|explain|understand|meaning|concept|idea)\b/i.test(query) ||
    /\b(感觉|怎么|为什么|什么|意思|概念|想法)\b/.test(query);

  if (hasAbstractTerms) {
    return { vectorWeight: 0.9, bm25Weight: 0.1 };
  }

  // Default balanced approach
  return { vectorWeight: 0.7, bm25Weight: 0.3 };
}

// ============================================================================
// Utility Functions
// ============================================================================

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vector dimensions must match");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================================
// Retriever Class
// ============================================================================

export class MemoryRetriever {
  private config: RetrievalConfig;
  private store: MemoryStore;
  private embedder: Embedder;
  private logger = getLogger();

  constructor(store: MemoryStore, embedder: Embedder, config: Partial<RetrievalConfig> = {}) {
    this.store = store;
    this.embedder = embedder;
    this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  }

  getConfig(): RetrievalConfig {
    return this.config;
  }

  // ============================================================================
  // Core Retrieval Method
  // ============================================================================

  async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
    const timerId = this.logger.perfStart('MemoryRetriever', 'retrieve');
    
    try {
      const { query, limit, scopeFilter, category } = context;

      this.logger.debug('MemoryRetriever', 'Starting retrieval', {
        query: query.slice(0, 50),
        limit,
        scopeFilter,
        category,
        mode: this.config.mode,
      });

      // Step 1: Embed query
      const queryVector = await this.embedder.embedQuery(query);

      // Step 2: Perform searches
      const vectorResults = await this.store.vectorSearch(
        queryVector,
        this.config.candidatePoolSize,
        this.config.minScore,
        scopeFilter,
        category
      );

      const bm25Results = this.config.mode === 'hybrid'
        ? await this.store.bm25Search(query, this.config.candidatePoolSize, scopeFilter, category)
        : [];

      this.logger.debug('MemoryRetriever', 'Search completed', {
        vectorResults: vectorResults.length,
        bm25Results: bm25Results.length,
      });

      // Step 3: Fusion and scoring
      let results = await this.fuseAndScore(vectorResults, bm25Results, query);

      // Step 4: Apply filters and limits
      results = this.applyFinalProcessing(results, limit);

      const duration = this.logger.perfEnd(timerId);
      this.logger.trackRetrieval(duration);
      this.logger.info('MemoryRetriever', `Retrieval completed in ${duration.toFixed(2)}ms`, {
        resultsCount: results.length,
        duration,
      });

      return results;
    } catch (error) {
      this.logger.perfEnd(timerId);
      this.logger.error('MemoryRetriever', 'Retrieval failed', error);
      throw error;
    }
  }

  // ============================================================================
  // Fusion and Scoring Pipeline
  // ============================================================================

  private async fuseAndScore(
    vectorResults: MemorySearchResult[],
    bm25Results: MemorySearchResult[],
    query: string
  ): Promise<RetrievalResult[]> {
    // Compute dynamic weights if enabled
    const weights = this.config.dynamicWeights 
      ? computeDynamicWeights(query)
      : { vectorWeight: this.config.vectorWeight, bm25Weight: this.config.bm25Weight };

    this.logger.debug('MemoryRetriever', 'Using weights', {
      vectorWeight: weights.vectorWeight,
      bm25Weight: weights.bm25Weight,
      dynamic: this.config.dynamicWeights,
    });

    // Combine results with RRF-style fusion
    const combined = new Map<string, { result: RetrievalResult; vectorRank?: number; bm25Rank?: number }>();

    // Process vector results
    vectorResults.forEach((result, idx) => {
      combined.set(result.entry.id, {
        result: {
          entry: result.entry,
          score: result.score * weights.vectorWeight,
          sources: {
            vector: { score: result.score, rank: idx + 1 },
          },
        },
        vectorRank: idx + 1,
      });
    });

    // Process BM25 results
    bm25Results.forEach((result, idx) => {
      const existing = combined.get(result.entry.id);
      if (existing) {
        // Already in vector results - boost score
        existing.result.score += result.score * weights.bm25Weight;
        existing.result.sources.bm25 = { score: result.score, rank: idx + 1 };
        existing.bm25Rank = idx + 1;
      } else {
        // Only in BM25 results
        combined.set(result.entry.id, {
          result: {
            entry: result.entry,
            score: result.score * weights.bm25Weight,
            sources: {
              bm25: { score: result.score, rank: idx + 1 },
            },
          },
          bm25Rank: idx + 1,
        });
      }
    });

    // Convert to array and apply multi-stage scoring
    let results = Array.from(combined.values()).map(item => {
      const result = item.result;
      
      // Apply recency boost
      result.score = this.applyRecencyBoost(result, item.result.entry.timestamp);
      
      // Apply importance weight
      result.score *= (0.7 + 0.3 * result.entry.importance);
      
      // Apply length normalization
      result.score = this.applyLengthNormalization(result, result.entry.text.length);
      
      return result;
    });

    // Apply reranking if enabled
    if (this.config.rerank === 'cross-encoder' && this.config.rerankApiKey) {
      results = await this.applyReranking(results, query);
    }

    // Apply time decay
    results.forEach(result => {
      result.score = this.applyTimeDecay(result, result.entry.timestamp);
    });

    // Apply hard minimum score cutoff
    results = results.filter(result => result.score >= this.config.hardMinScore);

    // Apply MMR for diversity
    results = this.applyMMR(results, query);

    return results;
  }

  // ============================================================================
  // Scoring Pipeline Stages
  // ============================================================================

  private applyRecencyBoost(result: RetrievalResult, timestamp: number): number {
    if (this.config.recencyHalfLifeDays <= 0) {
      return result.score;
    }

    const ageDays = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
    const boostFactor = Math.exp(-ageDays / this.config.recencyHalfLifeDays) * this.config.recencyWeight;
    
    return result.score * (1 + boostFactor);
  }

  private applyLengthNormalization(result: RetrievalResult, textLength: number): number {
    if (this.config.lengthNormAnchor <= 0) {
      return result.score;
    }

    const ratio = textLength / this.config.lengthNormAnchor;
    const factor = 1 / (1 + 0.5 * Math.log2(Math.max(1, ratio)));
    
    return result.score * factor;
  }

  private applyTimeDecay(result: RetrievalResult, timestamp: number): number {
    if (this.config.timeDecayHalfLifeDays <= 0) {
      return result.score;
    }

    const ageDays = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
    const decayFactor = 0.5 + 0.5 * Math.exp(-ageDays / this.config.timeDecayHalfLifeDays);
    
    return result.score * decayFactor;
  }

  private async applyReranking(results: RetrievalResult[], query: string): Promise<RetrievalResult[]> {
    if (!this.config.rerankApiKey || results.length === 0) {
      return results;
    }

    const timerId = this.logger.perfStart('MemoryRetriever', 'rerank');
    
    try {
      const documents = results.map(r => r.entry.text);
      
      // Build rerank request based on provider
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      let body: any;
      switch (this.config.rerankProvider) {
        case 'pinecone':
          headers['Api-Key'] = this.config.rerankApiKey;
          headers['X-Pinecone-API-Version'] = '2024-10';
          body = {
            model: this.config.rerankModel,
            query,
            documents: documents.map(text => ({ text })),
            top_n: documents.length,
          };
          break;
        case 'siliconflow':
        case 'jina':
        default:
          headers['Authorization'] = `Bearer ${this.config.rerankApiKey}`;
          body = {
            model: this.config.rerankModel,
            query,
            documents,
            top_n: documents.length,
          };
      }

      const response = await fetch(this.config.rerankEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Rerank API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // Parse response based on provider
      let rerankScores: Array<{ index: number; score: number }>;
      if (this.config.rerankProvider === 'pinecone') {
        rerankScores = (data.data || []).map((item: any) => ({
          index: item.index,
          score: item.score,
        }));
      } else {
        rerankScores = (data.results || []).map((item: any) => ({
          index: item.index,
          score: item.relevance_score,
        }));
      }

      // Apply rerank scores (60% rerank + 40% original)
      rerankScores.forEach(({ index, score }) => {
        if (results[index]) {
          results[index].sources.reranked = { score };
          results[index].score = score * 0.6 + results[index].score * 0.4;
        }
      });

      const duration = this.logger.perfEnd(timerId);
      this.logger.trackRerank(documents.length);
      this.logger.debug('MemoryRetriever', `Reranking completed in ${duration.toFixed(2)}ms`);

      return results.sort((a, b) => b.score - a.score);
    } catch (error) {
      this.logger.perfEnd(timerId);
      this.logger.warn('MemoryRetriever', 'Reranking failed, using original scores', error);
      return results.sort((a, b) => b.score - a.score);
    }
  }

  private applyMMR(results: RetrievalResult[], query: string, similarityThreshold: number = 0.85): RetrievalResult[] {
    if (results.length <= 1) {
      return results;
    }

    const selected: RetrievalResult[] = [];
    const remaining = [...results];

    while (remaining.length > 0 && selected.length < results.length) {
      if (selected.length === 0) {
        // Select highest scoring result
        selected.push(remaining.shift()!);
      } else {
        // Find next diverse result
        let bestIdx = -1;
        let bestScore = -1;

        for (let i = 0; i < remaining.length; i++) {
          const candidate = remaining[i];
          const similarity = this.computeMaxSimilarity(candidate, selected);
          
          if (similarity < similarityThreshold) {
            // Diverse enough - consider for selection
            if (candidate.score > bestScore) {
              bestScore = candidate.score;
              bestIdx = i;
            }
          }
        }

        if (bestIdx >= 0) {
          selected.push(remaining.splice(bestIdx, 1)[0]);
        } else {
          // No diverse results left
          break;
        }
      }
    }

    return selected;
  }

  private computeMaxSimilarity(result: RetrievalResult, selected: RetrievalResult[]): number {
    let maxSim = 0;
    
    for (const selectedResult of selected) {
      // Simplified: use entry text length as proxy (real MMR would compare vectors)
      const lenDiff = Math.abs(result.entry.text.length - selectedResult.entry.text.length);
      const similarity = 1 - (lenDiff / Math.max(result.entry.text.length, selectedResult.entry.text.length));
      maxSim = Math.max(maxSim, similarity);
    }
    
    return maxSim;
  }

  private applyFinalProcessing(results: RetrievalResult[], limit: number): RetrievalResult[] {
    // Sort by score
    results.sort((a, b) => b.score - a.score);

    // Apply limit
    results = results.slice(0, limit);

    // Filter noise if enabled
    if (this.config.filterNoise) {
      results = filterNoise(results, r => r.entry.text);
    }

    return results;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRetriever(
  store: MemoryStore,
  embedder: Embedder,
  config: Partial<RetrievalConfig> = {}
): MemoryRetriever {
  return new MemoryRetriever(store, embedder, config);
}
