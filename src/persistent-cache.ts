/**
 * Persistent Embedding Cache with SQLite Backend
 * Provides LRU caching with disk persistence across restarts
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

// ============================================================================
// Types
// ============================================================================

interface CacheEntry {
  textHash: string;
  text: string;
  vector: number[];
  createdAt: number;
  accessCount: number;
  lastAccessedAt: number;
}

interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: string;
  diskSize: number;
  oldestEntry: number;
  newestEntry: number;
}

interface PersistentCacheConfig {
  /** Maximum number of entries in cache */
  maxSize: number;
  /** TTL in minutes (0 = no expiry) */
  ttlMinutes: number;
  /** Database path */
  dbPath?: string;
  /** Enable/disable disk persistence */
  persistToDisk: boolean;
  /** Batch size for cleanup operations */
  cleanupBatchSize: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: PersistentCacheConfig = {
  maxSize: 5000,
  ttlMinutes: 60, // 1 hour
  persistToDisk: true,
  cleanupBatchSize: 100,
};

// ============================================================================
// Utility Functions
// ============================================================================

function computeTextHash(text: string, task?: string): string {
  const hash = createHash('sha256');
  hash.update(`${task || ''}:${text}`);
  return hash.digest('hex').slice(0, 24);
}

function serializeVector(vector: number[]): string {
  return JSON.stringify(vector);
}

function deserializeVector(data: string): number[] {
  return JSON.parse(data);
}

function getDefaultDbPath(): string {
  const home = homedir();
  const dbDir = join(home, '.openclaw', 'memory', 'cache');
  
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  
  return join(dbDir, 'embedding-cache.sqlite');
}

// ============================================================================
// Persistent Embedding Cache Class
// ============================================================================

export class PersistentEmbeddingCache {
  private config: PersistentCacheConfig;
  private db: Database | null = null;
  private memoryCache: Map<string, CacheEntry>;
  
  // In-memory stats
  private hits = 0;
  private misses = 0;
  private initialized = false;

  constructor(config: Partial<PersistentCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.memoryCache = new Map();
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      if (this.config.persistToDisk) {
        const dbPath = this.config.dbPath || getDefaultDbPath();
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('cache_size = -64000'); // 64MB cache
        
        this.createTables();
        this.loadFromDisk();
        this.cleanupOldEntries();
      }
      
      this.initialized = true;
    } catch (error) {
      console.warn('[PersistentEmbeddingCache] Failed to initialize disk cache, using memory only:', error);
      this.config.persistToDisk = false;
      this.initialized = true;
    }
  }

  private createTables(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        text_hash TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        vector TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_last_accessed 
      ON embedding_cache(last_accessed_at)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_created_at 
      ON embedding_cache(created_at)
    `);
  }

  private loadFromDisk(): void {
    if (!this.db) return;

    try {
      const stmt = this.db.prepare('SELECT * FROM embedding_cache ORDER BY last_accessed_at DESC');
      const rows = stmt.all() as any[];

      for (const row of rows) {
        if (this.memoryCache.size >= this.config.maxSize) {
          break;
        }

        this.memoryCache.set(row.text_hash, {
          textHash: row.text_hash,
          text: row.text,
          vector: deserializeVector(row.vector),
          createdAt: row.created_at,
          accessCount: row.access_count,
          lastAccessedAt: row.last_accessed_at,
        });
      }

      console.log(`[PersistentEmbeddingCache] Loaded ${this.memoryCache.size} entries from disk`);
    } catch (error) {
      console.warn('[PersistentEmbeddingCache] Failed to load from disk:', error);
    }
  }

  // ============================================================================
  // Core Cache Operations
  // ============================================================================

  get(text: string, task?: string): number[] | undefined {
    const key = computeTextHash(text, task);
    const entry = this.memoryCache.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check TTL
    if (this.config.ttlMinutes > 0) {
      const ageMinutes = (Date.now() - entry.lastAccessedAt) / 60000;
      if (ageMinutes > this.config.ttlMinutes) {
        this.delete(key);
        this.misses++;
        return undefined;
      }
    }

    // Update access metadata
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    this.memoryCache.set(key, entry);

    // Persist access count update
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          UPDATE embedding_cache 
          SET access_count = ?, last_accessed_at = ? 
          WHERE text_hash = ?
        `);
        stmt.run(entry.accessCount, entry.lastAccessedAt, key);
      } catch (error) {
        // Ignore update errors, cache still works
      }
    }

    this.hits++;
    return entry.vector;
  }

  set(text: string, task: string | undefined, vector: number[]): void {
    const key = computeTextHash(text, task);
    
    // Check if already exists
    if (this.memoryCache.has(key)) {
      return;
    }

    // Evict oldest entries if at capacity
    while (this.memoryCache.size >= this.config.maxSize) {
      this.evictOldest();
    }

    const entry: CacheEntry = {
      textHash: key,
      text,
      vector,
      createdAt: Date.now(),
      accessCount: 0,
      lastAccessedAt: Date.now(),
    };

    this.memoryCache.set(key, entry);

    // Persist to disk
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT OR REPLACE INTO embedding_cache 
          (text_hash, text, vector, created_at, access_count, last_accessed_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(key, text, serializeVector(vector), entry.createdAt, entry.accessCount, entry.lastAccessedAt);
      } catch (error) {
        console.warn('[PersistentEmbeddingCache] Failed to persist entry:', error);
      }
    }
  }

  delete(key: string): void {
    this.memoryCache.delete(key);
    
    if (this.db) {
      try {
        const stmt = this.db.prepare('DELETE FROM embedding_cache WHERE text_hash = ?');
        stmt.run(key);
      } catch (error) {
        // Ignore delete errors
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.delete(oldestKey);
    }
  }

  // ============================================================================
  // Cleanup and Maintenance
  // ============================================================================

  cleanupOldEntries(): void {
    if (!this.db || this.config.ttlMinutes <= 0) {
      return;
    }

    try {
      const cutoffTime = Date.now() - (this.config.ttlMinutes * 60000);
      
      const deleteStmt = this.db.prepare(`
        DELETE FROM embedding_cache 
        WHERE last_accessed_at < ?
      `);
      
      const result = deleteStmt.run(cutoffTime);
      
      if (result.changes > 0) {
        console.log(`[PersistentEmbeddingCache] Cleaned up ${result.changes} expired entries`);
      }
    } catch (error) {
      console.warn('[PersistentEmbeddingCache] Cleanup failed:', error);
    }
  }

  shrinkToSize(targetSize: number): void {
    while (this.memoryCache.size > targetSize) {
      this.evictOldest();
    }
  }

  // ============================================================================
  // Stats and Monitoring
  // ============================================================================

  getStats(): CacheStats {
    const entries = Array.from(this.memoryCache.values());
    const oldest = entries.reduce((min, e) => Math.min(min, e.createdAt), Infinity);
    const newest = entries.reduce((max, e) => Math.max(max, e.createdAt), -Infinity);

    const total = this.hits + this.misses;
    const hitRate = total > 0 ? ((this.hits / total) * 100).toFixed(1) : '0';

    let diskSize = 0;
    if (this.db) {
      try {
        const stmt = this.db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()');
        const result = stmt.get() as any;
        diskSize = result?.size || 0;
      } catch {
        diskSize = 0;
      }
    }

    return {
      size: this.memoryCache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: `${hitRate}%`,
      diskSize,
      oldestEntry: oldest === Infinity ? 0 : oldest,
      newestEntry: newest === -Infinity ? 0 : newest,
    };
  }

  get size(): number {
    return this.memoryCache.size;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async close(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
        this.db = null;
        console.log('[PersistentEmbeddingCache] Database connection closed');
      } catch (error) {
        console.warn('[PersistentEmbeddingCache] Failed to close database:', error);
      }
    }
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    this.hits = 0;
    this.misses = 0;

    if (this.db) {
      try {
        this.db.exec('DELETE FROM embedding_cache');
        console.log('[PersistentEmbeddingCache] Cache cleared');
      } catch (error) {
        console.warn('[PersistentEmbeddingCache] Failed to clear disk cache:', error);
      }
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalCache: PersistentEmbeddingCache | null = null;

export async function getPersistentCache(
  config?: Partial<PersistentCacheConfig>
): Promise<PersistentEmbeddingCache> {
  if (!globalCache) {
    globalCache = new PersistentEmbeddingCache(config);
    await globalCache.initialize();
  }
  return globalCache;
}

export function resetCache(): void {
  globalCache = null;
}
