/**
 * Agent Memory Migration Script
 *
 * 将所有 agent workspace 下的记忆文件导入到 LanceDB
 *
 * ⚠️ 警告：这是初始化导入脚本，会清空现有 LanceDB 中的所有数据！
 *
 * 数据源:
 * - /home/zhangcb/.openclaw/workspace/MEMORY.md (main 代理长期记忆)
 * - /home/zhangcb/.openclaw/workspace/memory/*.md (main 代理日常记忆)
 * - /home/zhangcb/.openclaw/workspace-<agentid>/MEMORY.md (各 agent 长期记忆)
 * - /home/zhangcb/.openclaw/workspace-<agentid>/memory/*.md (各 agent 日常记忆)
 *
 * 使用方法:
 *   npx tsx scripts/migrate-agent-memories.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { MemoryStore, type MemoryEntry } from "../src/store.js";
import { createEmbedder, getVectorDimensions } from "../src/embedder.js";

// ============================================================================
// Configuration
// ============================================================================

const OPENCLAW_BASE = join(homedir(), ".openclaw");
const DB_PATH = join(OPENCLAW_BASE, "memory", "lancedb-pro");

// Agent workspace 配置
const AGENTS = [
  { workspace: "workspace", agentId: "main" },
  { workspace: "workspace-codefarmer", agentId: "codefarmer" },
  { workspace: "workspace-makemoney", agentId: "makemoney" },
  { workspace: "workspace-moltbook", agentId: "moltbook" },
  { workspace: "workspace-bot_xw", agentId: "bot_xw" },
  { workspace: "workspace-bot_yuanbaomama", agentId: "bot_yuanbaomama" },
  { workspace: "workspace-bot_zcl", agentId: "bot_zcl" },
  { workspace: "workspace-story-weaver", agentId: "story-weaver" },
];

// Embedding 配置（从环境变量读取）
const EMBEDDING_CONFIG = {
  provider: "openai-compatible" as const,
  apiKey: process.env.OPENAI_API_KEY || "",
  model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
  baseURL: process.env.EMBEDDING_BASE_URL || undefined,
  dimensions: process.env.EMBEDDING_DIMENSIONS
    ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10)
    : undefined,
};

// ============================================================================
// Memory Parser
// ============================================================================

/**
 * 解析 MEMORY.md 文件，提取结构化记忆条目
 */
function parseMemoryMd(content: string, agentId: string): Array<{ text: string; category: "fact" | "decision" | "other"; importance: number }> {
  const memories: Array<{ text: string; category: "fact" | "decision" | "other"; importance: number }> = [];

  const lines = content.split("\n");
  let currentSection = "";
  let currentItem: string[] = [];

  const flushItem = () => {
    if (currentItem.length > 0) {
      const text = currentItem.join("\n").trim();
      if (text.length > 10) { // 忽略太短的内容
        let category: "fact" | "decision" | "other" = "other";
        let importance = 0.7;

        // 根据内容判断 category
        const lowerText = text.toLowerCase();
        if (/rule|原则 | 规则 | best practice|最佳实践|must|必须 | 应该 | 不要 | avoid/i.test(lowerText)) {
          category = "decision";
          importance = 0.85;
        } else if (/已完成 | completed|项目 | project|system|配置 | config|service/i.test(lowerText)) {
          category = "fact";
          importance = 0.8;
        }

        memories.push({
          text: `[${agentId}] ${text}`,
          category,
          importance,
        });
      }
      currentItem = [];
    }
  };

  for (const line of lines) {
    // 检测新的 section
    if (line.startsWith("## ")) {
      flushItem();
      currentSection = line.slice(3).trim();
      continue;
    }

    // 检测列表项
    if (line.startsWith("- ") || line.match(/^\d+\.\s/)) {
      flushItem();
      currentItem.push(line.replace(/^[-*]\s*|^\d+\.\s*/, ""));
      continue;
    }

    // 累积当前项的内容
    if (currentItem.length > 0 && line.trim() && !line.startsWith("#")) {
      currentItem.push(line.trim());
    }
  }

  flushItem();

  return memories;
}

/**
 * 解析日常记忆文件（日志格式）
 */
function parseDailyMemory(content: string, agentId: string, filename: string): Array<{ text: string; category: "fact" | "decision" | "other"; importance: number }> {
  const memories: Array<{ text: string; category: "fact" | "decision" | "other"; importance: number }> = [];

  const lines = content.split("\n");
  let currentSection: string[] = [];
  let sectionTitle = "";

  const flushSection = () => {
    if (currentSection.length > 0) {
      const text = currentSection.join("\n").trim();
      if (text.length > 20) { // 忽略太短的内容
        let category: "fact" | "decision" | "other" = "other";
        let importance = 0.6;

        const lowerText = text.toLowerCase();
        if (/决定 | decided|结论 | conclusion|方案 | solution/i.test(lowerText)) {
          category = "decision";
          importance = 0.75;
        } else if (/配置 | config|部署 | deploy|修复 | fix|创建 | create/i.test(lowerText)) {
          category = "fact";
          importance = 0.7;
        }

        memories.push({
          text: `[${agentId}][${filename}] ${sectionTitle ? sectionTitle + ": " : ""}${text}`,
          category,
          importance,
        });
      }
      currentSection = [];
      sectionTitle = "";
    }
  };

  for (const line of lines) {
    // 检测三级标题（###）
    if (line.startsWith("### ")) {
      flushSection();
      sectionTitle = line.slice(4).trim();
      continue;
    }

    // 检测四级标题（####）
    if (line.startsWith("#### ")) {
      flushSection();
      sectionTitle = line.slice(5).trim();
      continue;
    }

    // 累积内容
    if (line.trim() && !line.startsWith("#") && !line.startsWith("---")) {
      currentSection.push(line.trim());
    }
  }

  flushSection();

  return memories;
}

// ============================================================================
// Main Migration Logic
// ============================================================================

async function discoverAgentFiles(): Promise<Array<{ agentId: string; scope: string; memoryMdPath: string | null; dailyMdPaths: string[] }>> {
  const results: Array<{ agentId: string; scope: string; memoryMdPath: string | null; dailyMdPaths: string[] }> = [];

  for (const { workspace, agentId } of AGENTS) {
    const workspacePath = join(OPENCLAW_BASE, workspace);
    const scope = `agent:${agentId}`;

    if (!existsSync(workspacePath)) {
      console.log(`跳过：${workspace} (目录不存在)`);
      continue;
    }

    // 检查 MEMORY.md
    const memoryMdPath = join(workspacePath, "MEMORY.md");
    const hasMemoryMd = existsSync(memoryMdPath);

    // 检查 memory 目录
    const memoryDir = join(workspacePath, "memory");
    const dailyMdPaths: string[] = [];

    if (existsSync(memoryDir)) {
      const files = await readdir(memoryDir);
      for (const file of files.filter(f => f.endsWith(".md"))) {
        dailyMdPaths.push(join(memoryDir, file));
      }
    }

    if (hasMemoryMd || dailyMdPaths.length > 0) {
      results.push({
        agentId,
        scope,
        memoryMdPath: hasMemoryMd ? memoryMdPath : null,
        dailyMdPaths,
      });
      console.log(`发现：${agentId} - MEMORY.md: ${hasMemoryMd}, 日常记忆：${dailyMdPaths.length} 个文件`);
    } else {
      console.log(`跳过：${agentId} (无记忆文件)`);
    }
  }

  return results;
}

async function clearDatabase(store: MemoryStore): Promise<number> {
  console.log("清空现有数据库（删除并重建表）...");

  // 由于旧表 schema 可能缺少字段，需要删除整个表重新创建
  // 使用底层 LanceDB API 直接删除表
  const { loadLanceDB } = await import("../src/store.js");
  const lancedb = await loadLanceDB();
  const db = await lancedb.connect(store.dbPath);

  // 获取所有表名
  const tableNames = await db.tableNames();

  let totalDeleted = 0;

  if (tableNames.includes("memories")) {
    // 读取现有数据量
    const table = await db.openTable("memories");
    const rows = await table.query().toArray();
    totalDeleted = rows.length;

    // 删除表
    await db.dropTable("memories");
    console.log(`已删除 memories 表（${totalDeleted} 条记录）`);
  }

  // 关闭连接（store 会重新初始化）
  await db.close();

  console.log(`共删除 ${totalDeleted} 条现有记录`);
  return totalDeleted;
}

async function importMemories(
  store: MemoryStore,
  embedder: ReturnType<typeof createEmbedder>,
  agentFiles: Array<{ agentId: string; scope: string; memoryMdPath: string | null; dailyMdPaths: string[] }>
): Promise<number> {
  let totalImported = 0;

  for (const { agentId, scope, memoryMdPath, dailyMdPaths } of agentFiles) {
    console.log(`\n=== 导入 ${agentId} (scope: ${scope}) ===`);

    // 导入 MEMORY.md
    if (memoryMdPath) {
      const content = await readFile(memoryMdPath, "utf-8");
      const memories = parseMemoryMd(content, agentId);

      console.log(`  MEMORY.md: ${memories.length} 条记忆`);

      for (const memory of memories) {
        const vector = await (await embedder).embedPassage(memory.text);
        await store.store({
          text: memory.text,
          vector,
          category: memory.category,
          scope,
          importance: memory.importance,
          metadata: JSON.stringify({ source: "MEMORY.md", file: memoryMdPath }),
        });
        totalImported++;
      }
    }

    // 导入日常记忆文件
    for (const dailyPath of dailyMdPaths) {
      const filename = dailyPath.split("/").pop() || "";
      const content = await readFile(dailyPath, "utf-8");
      const memories = parseDailyMemory(content, agentId, filename);

      if (memories.length > 0) {
        console.log(`  ${filename}: ${memories.length} 条记忆`);

        for (const memory of memories) {
          const vector = await (await embedder).embedPassage(memory.text);
          await store.store({
            text: memory.text,
            vector,
            category: memory.category,
            scope,
            importance: memory.importance,
            metadata: JSON.stringify({ source: "daily", file: dailyPath }),
          });
          totalImported++;
        }
      }
    }
  }

  return totalImported;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Agent Memory Migration Script");
  console.log("=".repeat(60));
  console.log("");
  console.log("⚠️  警告：此脚本会清空现有 LanceDB 中的所有数据！");
  console.log("");

  // 检查环境变量
  if (!EMBEDDING_CONFIG.apiKey) {
    console.error("错误：需要设置 OPENAI_API_KEY 环境变量");
    process.exit(1);
  }

  // 初始化组件
  console.log(`数据库路径：${DB_PATH}`);
  console.log(`Embedding 模型：${EMBEDDING_CONFIG.model}`);
  console.log("");

  const vectorDim = getVectorDimensions(
    EMBEDDING_CONFIG.model,
    EMBEDDING_CONFIG.dimensions
  );

  const store = new MemoryStore({ dbPath: DB_PATH, vectorDim });
  const embedder = createEmbedder(EMBEDDING_CONFIG);

  try {
    // 发现 Agent 文件
    console.log("扫描 Agent 记忆文件...");
    const agentFiles = await discoverAgentFiles();
    console.log("");

    if (agentFiles.length === 0) {
      console.log("没有找到任何记忆文件");
      return;
    }

    // 清空数据库
    await clearDatabase(store);

    // 导入记忆
    const totalImported = await importMemories(store, embedder, agentFiles);

    console.log("");
    console.log("=".repeat(60));
    console.log(`迁移完成！共导入 ${totalImported} 条记忆`);
    console.log("=".repeat(60));

    // 显示统计
    const stats = await store.stats();
    console.log("");
    console.log("按 Scope 统计:");
    for (const [scope, count] of Object.entries(stats.scopeCounts)) {
      console.log(`  ${scope}: ${count}`);
    }

    console.log("");
    console.log("按 Category 统计:");
    for (const [category, count] of Object.entries(stats.categoryCounts)) {
      console.log(`  ${category}: ${count}`);
    }
  } catch (error) {
    console.error("迁移失败:", error);
    process.exit(1);
  } finally {
    await (await embedder).destroy();
  }
}

main();
