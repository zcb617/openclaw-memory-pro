// Type declarations for OpenClaw plugin SDK
// These types are provided by the OpenClaw runtime at runtime

declare module "openclaw/plugin-sdk" {
  import type { Type } from "@sinclair/typebox";

  export interface OpenClawPluginApi {
    registerTool(tool: ToolDefinition, options?: { name: string }): void;
    registerCli(cli: (program: any) => void, options?: { commands: string[] }): void;
    registerService(service: { id: string; start: () => Promise<void>; stop: () => void }): void;
    registerHook(event: string, handler: (...args: any[]) => Promise<any>): void;
    on(event: string, handler: (...args: any[]) => Promise<any>): void;
    pluginConfig: Record<string, unknown>;
    resolvePath(path: string): string;
    logger: {
      info(message: string, data?: any): void;
      warn(message: string, data?: any): void;
      error(message: string, data?: any): void;
      debug(message: string, data?: any): void;
    };
  }

  export interface ToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: any; // TypeBox schema
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      details?: Record<string, unknown>;
    }>;
  }

  export function stringEnum(values: readonly string[]): any;
}
