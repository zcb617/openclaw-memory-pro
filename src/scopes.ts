/**
 * Multi-Scope Access Control System with Validation
 * - Format validation for scope names
 * - Access control enforcement
 * - Scope isolation
 */

// ============================================================================
// Types & Configuration
// ============================================================================

export interface ScopeDefinition {
  description: string;
  metadata?: Record<string, unknown>;
}

export interface ScopeConfig {
  default: string;
  definitions: Record<string, ScopeDefinition>;
  agentAccess: Record<string, string[]>;
}

export interface ScopeManager {
  getAccessibleScopes(agentId?: string): string[];
  getDefaultScope(agentId?: string): string;
  isAccessible(scope: string, agentId?: string): boolean;
  validateScope(scope: string): boolean;
  getAllScopes(): string[];
  getScopeDefinition(scope: string): ScopeDefinition | undefined;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_SCOPE_CONFIG: ScopeConfig = {
  default: "global",
  definitions: {
    global: {
      description: "Shared knowledge across all agents",
    },
  },
  agentAccess: {},
};

// ============================================================================
// Scope Patterns and Validation
// ============================================================================

const SCOPE_PATTERNS = {
  GLOBAL: "global",
  AGENT: (agentId: string) => `agent:${agentId}`,
  CUSTOM: (name: string) => `custom:${name}`,
  PROJECT: (projectId: string) => `project:${projectId}`,
  USER: (userId: string) => `user:${userId}`,
};

/**
 * Validate scope name format
 * Valid formats:
 * - "global"
 * - "agent:<id>"
 * - "custom:<name>"
 * - "project:<id>"
 * - "user:<id>"
 */
export function validateScopeFormat(scope: string): { valid: boolean; error?: string } {
  if (!scope || typeof scope !== 'string') {
    return { valid: false, error: "Scope must be a non-empty string" };
  }

  // Check for "global"
  if (scope === "global") {
    return { valid: true };
  }

  // Check for prefixed scopes
  const validPrefixes = ["agent:", "custom:", "project:", "user:"];
  const hasValidPrefix = validPrefixes.some(prefix => scope.startsWith(prefix));

  if (!hasValidPrefix) {
    return {
      valid: false,
      error: `Invalid scope format. Must be "global" or start with one of: ${validPrefixes.join(", ")}`
    };
  }

  // Validate the part after prefix
  const [prefix, ...restParts] = scope.split(":");
  const identifier = restParts.join(":");

  if (!identifier || identifier.length < 1 || identifier.length > 100) {
    return {
      valid: false,
      error: `Identifier after "${prefix}:" must be 1-100 characters`
    };
  }

  // Check for invalid characters
  if (!/^[\w\-_.]+$/.test(identifier)) {
    return {
      valid: false,
      error: `Identifier contains invalid characters. Only alphanumeric, hyphen, underscore, and dot are allowed.`
    };
  }

  return { valid: true };
}

// ============================================================================
// Scope Manager Implementation
// ============================================================================

export class MemoryScopeManager implements ScopeManager {
  private config: ScopeConfig;

  constructor(config: Partial<ScopeConfig> = {}) {
    this.config = {
      default: config.default || DEFAULT_SCOPE_CONFIG.default,
      definitions: {
        ...DEFAULT_SCOPE_CONFIG.definitions,
        ...config.definitions,
      },
      agentAccess: {
        ...DEFAULT_SCOPE_CONFIG.agentAccess,
        ...config.agentAccess,
      },
    };

    this.validateConfiguration();
  }

  private validateConfiguration(): void {
    // Validate default scope exists in definitions
    if (!this.config.definitions[this.config.default]) {
      throw new Error(`Default scope '${this.config.default}' not found in definitions`);
    }

    // Validate all defined scopes have valid format
    for (const [scopeName, definition] of Object.entries(this.config.definitions)) {
      const validation = validateScopeFormat(scopeName);
      if (!validation.valid) {
        throw new Error(`Invalid scope name '${scopeName}': ${validation.error}`);
      }
    }

    // Validate agent access scopes
    for (const [agentId, scopes] of Object.entries(this.config.agentAccess)) {
      for (const scope of scopes) {
        if (!this.config.definitions[scope] && !this.isBuiltInScope(scope)) {
          console.warn(`Agent '${agentId}' has access to undefined scope '${scope}'`);
        }
      }
    }
  }

  private isBuiltInScope(scope: string): boolean {
    return (
      scope === "global" ||
      scope.startsWith("agent:") ||
      scope.startsWith("custom:") ||
      scope.startsWith("project:") ||
      scope.startsWith("user:")
    );
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  getAccessibleScopes(agentId?: string): string[] {
    if (!agentId) {
      return this.getAllScopes();
    }

    // Check explicit agent access configuration
    const explicitAccess = this.config.agentAccess[agentId];
    if (explicitAccess) {
      return explicitAccess;
    }

    // Default access: global + agent-specific scope
    const defaultScopes = ["global"];
    const agentScope = SCOPE_PATTERNS.AGENT(agentId);

    if (this.config.definitions[agentScope] || this.isBuiltInScope(agentScope)) {
      defaultScopes.push(agentScope);
    }

    return defaultScopes;
  }

  getDefaultScope(agentId?: string): string {
    if (!agentId) {
      return this.config.default;
    }

    const agentScope = SCOPE_PATTERNS.AGENT(agentId);
    const accessibleScopes = this.getAccessibleScopes(agentId);

    if (accessibleScopes.includes(agentScope)) {
      return agentScope;
    }

    return this.config.default;
  }

  isAccessible(scope: string, agentId?: string): boolean {
    // First validate scope format
    const validation = validateScopeFormat(scope);
    if (!validation.valid) {
      console.warn(`Attempted to access invalid scope: ${validation.error}`);
      return false;
    }

    return this.getAccessibleScopes(agentId).includes(scope);
  }

  validateScope(scope: string): boolean {
    const validation = validateScopeFormat(scope);
    return validation.valid;
  }

  getAllScopes(): string[] {
    return Object.keys(this.config.definitions);
  }

  getScopeDefinition(scope: string): ScopeDefinition | undefined {
    return this.config.definitions[scope];
  }

  // ============================================================================
  // Management Methods
  // ============================================================================

  addScope(scope: string, definition: ScopeDefinition): void {
    const validation = validateScopeFormat(scope);
    if (!validation.valid) {
      throw new Error(`Cannot add scope '${scope}': ${validation.error}`);
    }

    this.config.definitions[scope] = definition;
  }

  removeScope(scope: string): void {
    if (scope === "global" || scope === this.config.default) {
      throw new Error(`Cannot remove scope '${scope}' (global or default)`);
    }

    delete this.config.definitions[scope];

    // Remove from agent access lists
    for (const agentId of Object.keys(this.config.agentAccess)) {
      this.config.agentAccess[agentId] = this.config.agentAccess[agentId].filter(s => s !== scope);
    }
  }

  grantAccess(agentId: string, scope: string): void {
    const validation = validateScopeFormat(scope);
    if (!validation.valid) {
      throw new Error(`Cannot grant access to invalid scope: ${validation.error}`);
    }

    if (!this.config.agentAccess[agentId]) {
      this.config.agentAccess[agentId] = [];
    }

    if (!this.config.agentAccess[agentId].includes(scope)) {
      this.config.agentAccess[agentId].push(scope);
    }
  }

  revokeAccess(agentId: string, scope: string): void {
    if (this.config.agentAccess[agentId]) {
      this.config.agentAccess[agentId] = this.config.agentAccess[agentId].filter(s => s !== scope);
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createScopeManager(config: Partial<ScopeConfig> = {}): ScopeManager {
  return new MemoryScopeManager(config);
}
