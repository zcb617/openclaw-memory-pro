/**
 * Environment Variable Resolver with Whitelist Security
 * Prevents unauthorized access to sensitive environment variables
 */

// ============================================================================
// Security Configuration
// ============================================================================

/**
 * Whitelist of allowed environment variables for this plugin.
 * Only these variables can be referenced via ${VAR_NAME} syntax.
 */
export const ALLOWED_ENV_VARS = [
  // Embedding API keys
  'JINA_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'SILICONFLOW_API_KEY',
  'PINECONE_API_KEY',
  'LITELLM_API_KEY',
  'IFLOW_API_KEY',
  'NVIDIA_API_KEY',
  'AZURE_OPENAI_API_KEY',
  
  // API Base URLs (optional overrides)
  'JINA_BASE_URL',
  'OPENAI_BASE_URL',
  'GEMINI_BASE_URL',
  'OLLAMA_BASE_URL',
  
  // Plugin configuration
  'OPENCLAW_MEMORY_PRO_DEBUG',
  'OPENCLAW_MEMORY_PRO_LOG_LEVEL',
];

/**
 * Blocked patterns to prevent accidental exposure of sensitive variables
 */
const BLOCKED_PATTERNS = [
  /^AWS_/i,
  /^DATABASE_/i,
  /^DB_/i,
  /^SECRET_/i,
  /^PRIVATE_/i,
  /^ENCRYPTION_/i,
  /^SSH_/i,
  /^GITHUB_TOKEN$/i,
  /^GH_/i,
  /^NPM_/i,
  /^NODE_/i,
];

// ============================================================================
// Types
// ============================================================================

export interface EnvResolverConfig {
  /** Strict mode: throw error on blocked/blocked vars (default: true) */
  strict?: boolean;
  /** Custom whitelist (extends default whitelist) */
  additionalVars?: string[];
  /** Silent mode: don't log warnings */
  silent?: boolean;
}

export interface EnvResolverResult {
  /** Resolved value */
  value: string;
  /** Whether the value was resolved from env var */
  resolved: boolean;
  /** Original variable name */
  varName?: string;
  /** Whether access was blocked by security check */
  blocked?: boolean;
}

// ============================================================================
// Security Checks
// ============================================================================

/**
 * Check if a variable name is blocked by security policy
 */
function isBlocked(varName: string): boolean {
  return BLOCKED_PATTERNS.some(pattern => pattern.test(varName));
}

/**
 * Check if a variable name is in the allowed list
 */
function isAllowed(varName: string, additionalVars?: string[]): boolean {
  const allAllowed = [...ALLOWED_ENV_VARS, ...(additionalVars || [])];
  return allAllowed.includes(varName);
}

/**
 * Validate and resolve a single environment variable
 */
export function resolveEnvVar(
  varName: string,
  config: EnvResolverConfig = {}
): EnvResolverResult {
  const { strict = true, additionalVars, silent = false } = config;

  // Security check 1: Check if blocked
  if (isBlocked(varName)) {
    if (!silent) {
      console.warn(`[EnvResolver] Blocked access to sensitive variable: ${varName}`);
    }
    if (strict) {
      throw new Error(`Access to environment variable '${varName}' is blocked for security reasons`);
    }
    return {
      value: `\${${varName}}`,
      resolved: false,
      varName,
      blocked: true,
    };
  }

  // Security check 2: Check if allowed
  if (!isAllowed(varName, additionalVars)) {
    if (!silent) {
      console.warn(`[EnvResolver] Access denied to variable: ${varName}. Add it to the whitelist if needed.`);
    }
    if (strict) {
      throw new Error(`Environment variable '${varName}' is not in the allowed list. Allowed: ${ALLOWED_ENV_VARS.join(', ')}`);
    }
    return {
      value: `\${${varName}}`,
      resolved: false,
      varName,
      blocked: false,
    };
  }

  // Resolve the variable
  const envValue = process.env[varName];
  if (!envValue) {
    if (!silent) {
      console.warn(`[EnvResolver] Variable ${varName} is not set in environment`);
    }
    return {
      value: `\${${varName}}`,
      resolved: false,
      varName,
    };
  }

  return {
    value: envValue,
    resolved: true,
    varName,
  };
}

/**
 * Resolve all environment variables in a string
 * Supports ${VAR_NAME} syntax
 */
export function resolveEnvVars(
  value: string,
  config: EnvResolverConfig = {}
): string {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const result = resolveEnvVar(varName.trim(), config);
    return result.value;
  });
}

/**
 * Safely resolve a configuration object with environment variables
 * Recursively processes all string values
 */
export function resolveConfigEnvVars<T extends Record<string, any>>(
  config: T,
  options: EnvResolverConfig = {}
): T {
  const result: any = Array.isArray(config) ? [] : {};

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      result[key] = resolveEnvVars(value, options);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = resolveConfigEnvVars(value, options);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Get a list of all referenced environment variables in a string
 */
export function extractEnvVars(value: string): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  const matches = value.matchAll(/\$\{([^}]+)\}/g);
  return Array.from(matches, match => match[1].trim());
}

/**
 * Validate that all referenced environment variables are allowed
 */
export function validateEnvVars(
  value: string,
  additionalVars?: string[]
): { valid: boolean; invalid: string[] } {
  const referenced = extractEnvVars(value);
  const invalid: string[] = [];

  for (const varName of referenced) {
    if (isBlocked(varName) || !isAllowed(varName, additionalVars)) {
      invalid.push(varName);
    }
  }

  return {
    valid: invalid.length === 0,
    invalid,
  };
}
