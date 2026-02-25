/**
 * Embedding Abstraction Layer with Security and Performance Optimizations
 * - Environment variable whitelist for security
 * - Persistent LRU caching to reduce API calls
 * - Task-aware embeddings (query vs passage)
 * - Performance monitoring
 */

import OpenAI from 'openai';
import { resolveEnvVars, validateEnvVars } from './env-resolver.js';
import { getPersistentCache, PersistentEmbeddingCache } from './persistent-cache.js';
import { getLogger } from './logger.js';

// ============================================================================
// Types & Configuration
// ============================================================================

export interface EmbeddingConfig {
  provider: 'openai-compatible';
  apiKey: string;
  model: string;
  baseURL?: string;
  dimensions?: number;
  taskQuery?: string;
  taskPassage?: string;
  normalized?: boolean;
}

interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: string;
}

// ============================================================================
// Known Model Dimensions
// ============================================================================

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  // OpenAI
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-004': 768,
  
  // Google Gemini
  'gemini-embedding-001': 3072,
  
  // Ollama / Local
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  
  // BAAI
  'BAAI/bge-m3': 1024,
  'all-MiniLM-L6-v2': 384,
  'all-mpnet-base-v2': 768,
  
  // Jina v5 (recommended for this plugin)
  'jina-embeddings-v5-text-small': 1024,
  'jina-embeddings-v5-text-nano': 768,
};

// ============================================================================
// Utility Functions
// ============================================================================

export function getVectorDimensions(model: string, overrideDims?: number): number {
  if (overrideDims && overrideDims > 0) {
    return overrideDims;
  }

  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(
      `Unsupported embedding model: ${model}. Either add it to EMBEDDING_DIMENSIONS or set embedding.dimensions in config.`
    );
  }

  return dims;
}

// ============================================================================
// Embedder Class
// ============================================================================

export class Embedder {
  private client: OpenAI;
  private config: EmbeddingConfig;
  private cache: PersistentEmbeddingCache | null = null;
  private logger = getLogger();
  private cacheStats: { hits: number; misses: number } = { hits: 0, misses: 0 };

  constructor(config: EmbeddingConfig) {
    this.config = config;
    
    // Security: Validate and resolve environment variables with whitelist
    const apiKey = resolveEnvVars(config.apiKey, { strict: false });
    const baseURL = config.baseURL ? resolveEnvVars(config.baseURL, { strict: false }) : undefined;

    this.client = new OpenAI({
      apiKey,
      baseURL: baseURL || undefined,
    });

    // Initialize persistent cache
    this.initializeCache();
  }

  private async initializeCache(): Promise<void> {
    try {
      this.cache = await getPersistentCache({
        maxSize: 5000,
        ttlMinutes: 60,
        persistToDisk: true,
      });
      const stats = this.cache.getStats();
      this.logger.info('Embedder', `Persistent cache initialized with ${stats.size} entries`);
    } catch (error) {
      this.logger.warn('Embedder', 'Failed to initialize persistent cache, using memory-only cache', error);
      this.cache = null;
    }
  }

  // ============================================================================
  // Core Embedding Methods
  // ============================================================================

  async embedQuery(text: string): Promise<number[]> {
    const timerId = this.logger.perfStart('Embedder', 'embedQuery');
    
    try {
      const task = this.config.taskQuery;
      const vector = await this.getEmbedding(text, task);
      
      const duration = this.logger.perfEnd(timerId);
      this.logger.debug('Embedder', `Query embedded in ${duration.toFixed(2)}ms`, { 
        textLength: text.length, 
        vectorDim: vector.length 
      });
      
      return vector;
    } catch (error) {
      this.logger.perfEnd(timerId);
      this.logger.error('Embedder', 'Failed to embed query', error);
      throw error;
    }
  }

  async embedPassage(text: string): Promise<number[]> {
    const timerId = this.logger.perfStart('Embedder', 'embedPassage');
    
    try {
      const task = this.config.taskPassage;
      const vector = await this.getEmbedding(text, task);
      
      const duration = this.logger.perfEnd(timerId);
      this.logger.debug('Embedder', `Passage embedded in ${duration.toFixed(2)}ms`, { 
        textLength: text.length, 
        vectorDim: vector.length 
      });
      
      return vector;
    } catch (error) {
      this.logger.perfEnd(timerId);
      this.logger.error('Embedder', 'Failed to embed passage', error);
      throw error;
    }
  }

  // ============================================================================
  // Cache-Aware Embedding Retrieval
  // ============================================================================

  private async getEmbedding(text: string, task?: string): Promise<number[]> {
    const cacheKey = `${task || ''}:${text}`;
    
    // Try cache first
    if (this.cache) {
      const cachedVector = this.cache.get(text, task);
      if (cachedVector) {
        this.cacheStats.hits++;
        this.logger.debug('Embedder', 'Cache hit', { textLength: text.length, task });
        return cachedVector;
      }
      this.cacheStats.misses++;
    }

    // Cache miss - call API
    const timerId = this.logger.perfStart('Embedder', 'api-call');
    
    try {
      // Build request with provider-specific parameters
      const request: any = {
        model: this.config.model,
        input: text,
      };

      // Add task type for providers that support it (e.g., Jina v5)
      if (task && this.config.model.includes('jina')) {
        request.task = task;
      }

      // Add normalized flag for providers that support it
      if (this.config.normalized && this.config.model.includes('jina')) {
        request.normalized = this.config.normalized;
      }

      const response = await this.client.embeddings.create(request);
      const duration = this.logger.perfEnd(timerId);
      
      if (!response.data || response.data.length === 0) {
        throw new Error('Empty embedding response from API');
      }

      const vector = response.data[0].embedding;

      // Store in cache
      if (this.cache) {
        this.cache.set(text, task, vector);
      }

      this.logger.debug('Embedder', 'API call successful', { 
        duration: duration.toFixed(2),
        vectorDim: vector.length,
        cached: false 
      });

      return vector;
    } catch (error) {
      this.logger.perfEnd(timerId);
      this.logger.error('Embedder', 'API call failed', error);
      throw error;
    }
  }

  // ============================================================================
  // Cache Management
  // ============================================================================

  async getCacheStats(): Promise<CacheStats> {
    if (!this.cache) {
      return {
        size: 0,
        hits: this.cacheStats.hits,
        misses: this.cacheStats.misses,
        hitRate: '0%',
      };
    }

    const stats = this.cache.getStats();
    return {
      size: stats.size,
      hits: stats.hits + this.cacheStats.hits,
      misses: stats.misses + this.cacheStats.misses,
      hitRate: stats.hitRate,
    };
  }

  async clearCache(): Promise<void> {
    if (this.cache) {
      await this.cache.clear();
      this.logger.info('Embedder', 'Cache cleared');
    }
    this.cacheStats = { hits: 0, misses: 0 };
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async destroy(): Promise<void> {
    if (this.cache) {
      await this.cache.close();
      this.cache = null;
    }
    this.logger.info('Embedder', 'Embedder destroyed');
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export async function createEmbedder(config: EmbeddingConfig): Promise<Embedder> {
  // Validate configuration
  const validation = validateEnvVars(config.apiKey);
  if (!validation.valid) {
    throw new Error(`Invalid environment variable references in apiKey: ${validation.invalid.join(', ')}`);
  }

  const embedder = new Embedder(config);
  
  // Pre-warm cache with common queries (optional optimization)
  // await embedder.warmupCache();
  
  return embedder;
}

