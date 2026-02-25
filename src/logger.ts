/**
 * Debug Logger & Performance Monitor
 * Provides structured logging and performance tracking for memory operations
 */

// ============================================================================
// Types
// ============================================================================

export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error' | 'perf';
  scope: string;
  message: string;
  data?: any;
  durationMs?: number;
}

export interface PerformanceStats {
  // Retrieval stats
  retrievalCount: number;
  avgRetrievalTimeMs: number;
  minRetrievalTimeMs: number;
  maxRetrievalTimeMs: number;
  
  // Embedding stats
  embeddingCount: number;
  avgEmbeddingTimeMs: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: string;
  
  // API cost estimation (USD)
  totalApiCost: number;
  embeddingCost: number;
  rerankCost: number;
}

// ============================================================================
// Configuration
// ============================================================================

interface LoggerConfig {
  enabled: boolean;
  minLevel: 'debug' | 'info' | 'warn' | 'error';
  outputToConsole: boolean;
  outputToFile: boolean;
  logFilePath?: string;
  perfTracking: boolean;
}

const DEFAULT_CONFIG: LoggerConfig = {
  enabled: true,
  minLevel: 'info',
  outputToConsole: true,
  outputToFile: false,
  perfTracking: true,
};

// ============================================================================
// Log Level Hierarchy
// ============================================================================

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  perf: 4,
};

// ============================================================================
// Logger Implementation
// ============================================================================

export class MemoryLogger {
  private config: LoggerConfig;
  private logs: LogEntry[] = [];
  private maxLogsInMemory = 1000;
  
  // Performance tracking
  private perfTimers: Map<string, number> = new Map();
  private stats: PerformanceStats = {
    retrievalCount: 0,
    avgRetrievalTimeMs: 0,
    minRetrievalTimeMs: Infinity,
    maxRetrievalTimeMs: 0,
    embeddingCount: 0,
    avgEmbeddingTimeMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheHitRate: '0%',
    totalApiCost: 0,
    embeddingCost: 0,
    rerankCost: 0,
  };
  
  // Cost estimation (per 1K tokens or per request)
  private readonly COST_PER_EMBEDDING = 0.00001; // Approximate
  private readonly COST_PER_RERANK = 0.0001;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private shouldLog(level: string): boolean {
    return LOG_LEVELS[level as keyof typeof LOG_LEVELS] >= LOG_LEVELS[this.config.minLevel];
  }

  private formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }

  private formatMessage(entry: LogEntry): string {
    const time = this.formatTimestamp(entry.timestamp);
    const level = entry.level.toUpperCase().padEnd(5);
    const scope = `[${entry.scope}]`.padEnd(20);
    const data = entry.data ? ` | ${JSON.stringify(entry.data)}` : '';
    const duration = entry.durationMs !== undefined ? ` (${entry.durationMs.toFixed(2)}ms)` : '';
    
    return `${time} ${level} ${scope} ${entry.message}${duration}${data}`;
  }

  private output(entry: LogEntry): void {
    if (!this.config.enabled || !this.shouldLog(entry.level)) {
      return;
    }

    const formatted = this.formatMessage(entry);
    
    // Console output
    if (this.config.outputToConsole) {
      switch (entry.level) {
        case 'error':
          console.error(formatted);
          break;
        case 'warn':
          console.warn(formatted);
          break;
        case 'perf':
          console.log(`\x1b[36m${formatted}\x1b[0m`); // Cyan for performance logs
          break;
        case 'debug':
          console.debug(formatted);
          break;
        default:
          console.log(formatted);
      }
    }

    // File output (TODO: implement file writer)
    if (this.config.outputToFile && this.config.logFilePath) {
      // TODO: Write to file
    }

    // Keep in-memory log buffer
    this.logs.push(entry);
    if (this.logs.length > this.maxLogsInMemory) {
      this.logs.shift();
    }
  }

  // ============================================================================
  // Public Logging Methods
  // ============================================================================

  debug(scope: string, message: string, data?: any): void {
    this.output({ timestamp: Date.now(), level: 'debug', scope, message, data });
  }

  info(scope: string, message: string, data?: any): void {
    this.output({ timestamp: Date.now(), level: 'info', scope, message, data });
  }

  warn(scope: string, message: string, error?: any): void {
    this.output({ 
      timestamp: Date.now(), 
      level: 'warn', 
      scope, 
      message, 
      data: error instanceof Error ? error.message : error 
    });
  }

  error(scope: string, message: string, error?: any): void {
    this.output({ 
      timestamp: Date.now(), 
      level: 'error', 
      scope, 
      message, 
      data: error instanceof Error ? { message: error.message, stack: error.stack } : error 
    });
  }

  // ============================================================================
  // Performance Tracking Methods
  // ============================================================================

  perfStart(scope: string, operation: string): string {
    if (!this.config.perfTracking) return '';
    
    const timerId = `${scope}:${operation}`;
    this.perfTimers.set(timerId, performance.now());
    return timerId;
  }

  perfEnd(timerId: string, message?: string): number {
    if (!this.config.perfTracking) return 0;
    
    const startTime = this.perfTimers.get(timerId);
    if (!startTime) {
      this.warn('MemoryLogger', `perfEnd called for unknown timer: ${timerId}`);
      return 0;
    }
    
    const duration = performance.now() - startTime;
    this.perfTimers.delete(timerId);
    
    const [scope, operation] = timerId.split(':');
    this.output({
      timestamp: Date.now(),
      level: 'perf',
      scope,
      message: message || operation,
      durationMs: duration,
    });
    
    return duration;
  }

  // ============================================================================
  // Stats Tracking
  // ============================================================================

  trackRetrieval(durationMs: number): void {
    if (!this.config.perfTracking) return;
    
    this.stats.retrievalCount++;
    this.stats.avgRetrievalTimeMs = 
      (this.stats.avgRetrievalTimeMs * (this.stats.retrievalCount - 1) + durationMs) / this.stats.retrievalCount;
    this.stats.minRetrievalTimeMs = Math.min(this.stats.minRetrievalTimeMs, durationMs);
    this.stats.maxRetrievalTimeMs = Math.max(this.stats.maxRetrievalTimeMs, durationMs);
  }

  trackEmbedding(durationMs: number, cached: boolean): void {
    if (!this.config.perfTracking) return;
    
    if (cached) {
      this.stats.cacheHits++;
    } else {
      this.stats.embeddingCount++;
      this.stats.avgEmbeddingTimeMs = 
        (this.stats.avgEmbeddingTimeMs * (this.stats.embeddingCount - 1) + durationMs) / this.stats.embeddingCount;
      this.stats.embeddingCost += this.COST_PER_EMBEDDING;
    }
    
    this.updateCacheHitRate();
  }

  trackRerank(count: number): void {
    if (!this.config.perfTracking) return;
    
    this.stats.rerankCost += count * this.COST_PER_RERANK;
    this.stats.totalApiCost = this.stats.embeddingCost + this.stats.rerankCost;
  }

  private updateCacheHitRate(): void {
    const total = this.stats.cacheHits + this.stats.embeddingCount;
    const rate = total > 0 ? ((this.stats.cacheHits / total) * 100).toFixed(1) : '0';
    this.stats.cacheHitRate = `${rate}%`;
  }

  getStats(): PerformanceStats {
    return {
      ...this.stats,
      // Fix Infinity for JSON serialization
      minRetrievalTimeMs: this.stats.minRetrievalTimeMs === Infinity ? 0 : this.stats.minRetrievalTimeMs,
    };
  }

  resetStats(): void {
    this.stats = {
      retrievalCount: 0,
      avgRetrievalTimeMs: 0,
      minRetrievalTimeMs: Infinity,
      maxRetrievalTimeMs: 0,
      embeddingCount: 0,
      avgEmbeddingTimeMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: '0%',
      totalApiCost: 0,
      embeddingCost: 0,
      rerankCost: 0,
    };
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalLogger: MemoryLogger | null = null;

export function getLogger(config?: Partial<LoggerConfig>): MemoryLogger {
  if (!globalLogger) {
    globalLogger = new MemoryLogger(config);
  }
  return globalLogger;
}

export function setLogger(logger: MemoryLogger): void {
  globalLogger = logger;
}
