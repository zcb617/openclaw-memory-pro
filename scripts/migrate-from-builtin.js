#!/usr/bin/env node
/**
 * 从 OpenClaw 内置记忆系统迁移到 openclaw-memory-pro
 * 
 * 用法：
 *   node scripts/migrate-from-builtin.js [--dry-run]
 * 
 * 环境变量：
 *   SOURCE_DB - 源数据库路径 (默认：~/.openclaw/memory/main.sqlite)
 *   TARGET_DB - 目标数据库路径 (默认：~/.openclaw/memory/lancedb-pro)
 *   DEFAULT_SCOPE - 默认作用域 (默认：global)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// ============================================================================
// 配置
// ============================================================================

const DEFAULT_SOURCE_DB = join(homedir(), ".openclaw", "memory", "main.sqlite");
const DEFAULT_TARGET_DB = join(homedir(), ".openclaw", "memory", "lancedb-pro");

// ============================================================================
// LanceDB 动态导入
// ============================================================================

async function loadLanceDB() {
  try {
    const lancedb = await import("@lancedb/lancedb");
    return lancedb;
  } catch (error) {
    throw new Error(`无法加载 LanceDB: ${error.message}`);
  }
}

// ============================================================================
// 主迁移函数
// ============================================================================

async function migrate() {
  const args = process.argv.slice(2);
  const sourceDbPath = process.env.SOURCE_DB || DEFAULT_SOURCE_DB;
  const targetDbPath = process.env.TARGET_DB || DEFAULT_TARGET_DB;
  const dryRun = args.includes("--dry-run");
  const scope = process.env.DEFAULT_SCOPE || "global";

  console.log("🚀 OpenClaw 内置记忆系统 → openclaw-memory-pro 迁移工具\n");
  console.log(`源数据库：${sourceDbPath}`);
  console.log(`目标数据库：${targetDbPath}`);
  console.log(`作用域：${scope}`);
  console.log(`模式：${dryRun ? "🔍 DRY RUN (不会实际写入)" : "⚙️ 实际迁移"}\n`);

  // 1. 打开源数据库（内置 SQLite）
  console.log("📖 打开源数据库...");
  let sourceDb;
  try {
    sourceDb = new Database(sourceDbPath, { readonly: true });
    console.log("   ✓ 成功打开");
  } catch (error) {
    console.error(`❌ 无法打开源数据库：${error.message}`);
    process.exit(1);
  }

  // 2. 检查源数据
  console.log("\n📊 检查源数据...");
  const stats = sourceDb.prepare("SELECT COUNT(*) as count, source FROM chunks GROUP BY source").all();
  console.log("   记忆片段统计:");
  stats.forEach(row => {
    console.log(`   - ${row.source || 'memory'}: ${row.count} 条`);
  });

  // 3. 获取所有记忆片段
  console.log("\n📥 读取记忆数据...");
  const chunks = sourceDb.prepare(`
    SELECT id, path, source, start_line, end_line, text, embedding, updated_at
    FROM chunks
    ORDER BY updated_at DESC
  `).all();

  console.log(`   共 ${chunks.length} 条记忆`);

  if (chunks.length === 0) {
    console.log("✅ 没有需要迁移的数据");
    sourceDb.close();
    return;
  }

  // 4. 初始化目标存储（LanceDB）
  console.log("\n🏗️ 初始化目标数据库...");
  let db, table;
  try {
    const lancedb = await loadLanceDB();
    db = await lancedb.connect(targetDbPath);
    
    // 尝试打开或创建表
    try {
      table = await db.openTable("memories");
      console.log("   ✓ 使用现有的 memories 表");
    } catch {
      console.log("   ✓ 创建新的 memories 表...");
      const schemaEntry = {
        id: "__schema__",
        text: "",
        vector: Array(768).fill(0),
        category: "other",
        scope,
        importance: 0.5,
        timestamp: Date.now(),
        metadata: "{}",
      };
      table = await db.createTable("memories", [schemaEntry]);
      await table.delete('id = "__schema__"');
    }
  } catch (error) {
    console.error(`❌ 初始化 LanceDB 失败：${error.message}`);
    sourceDb.close();
    process.exit(1);
  }

  // 5. 迁移数据
  console.log("\n🔄 开始迁移...\n");
  
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const chunk of chunks) {
    try {
      // 解析 embedding（内置系统存储为 JSON 字符串）
      let vector;
      try {
        vector = JSON.parse(chunk.embedding);
      } catch {
        console.warn(`   ⚠️  跳过 ${chunk.id.slice(0, 8)}...：无法解析 embedding`);
        skipped++;
        continue;
      }

      // 验证向量维度
      if (!Array.isArray(vector) || vector.length < 100) {
        console.warn(`   ⚠️  跳过 ${chunk.id.slice(0, 8)}...：向量格式无效 (length: ${vector.length})`);
        skipped++;
        continue;
      }

      // 确定分类（根据路径和内容）
      let category = "other";
      if (chunk.path.includes("MEMORY.md") || chunk.path.startsWith("memory/")) {
        category = "fact";
      } else if (chunk.text.includes("偏好") || chunk.text.includes("喜欢") || chunk.text.toLowerCase().includes("prefer")) {
        category = "preference";
      } else if (chunk.text.includes("决定") || chunk.text.includes("选择") || chunk.text.toLowerCase().includes("decide")) {
        category = "decision";
      }

      // 生成新 ID（避免冲突）
      const newId = `builtin_${chunk.id.slice(0, 16)}`;

      if (dryRun) {
        console.log(`   [DRY] ${newId} | ${category} | ${chunk.text.slice(0, 60)}...`);
        migrated++;
      } else {
        // 添加到 LanceDB
        await table.add([{
          id: newId,
          text: chunk.text,
          vector,
          category,
          scope,
          importance: 0.7,
          timestamp: chunk.updated_at || Date.now(),
          metadata: JSON.stringify({
            source: "builtin_migration",
            originalPath: chunk.path,
            originalSource: chunk.source || "memory",
            migratedAt: Date.now(),
          }),
        }]);

        migrated++;
        if (migrated % 10 === 0) {
          console.log(`   ✓ 已迁移 ${migrated}/${chunks.length} 条`);
        }
      }
    } catch (error) {
      console.error(`   ❌ 迁移 ${chunk.id.slice(0, 8)}... 失败：${error.message}`);
      errors++;
    }
  }

  // 6. 显示结果
  console.log("\n" + "=".repeat(60));
  console.log("📊 迁移结果");
  console.log("=".repeat(60));
  console.log(`✅ 成功：${migrated} 条`);
  console.log(`⚠️  跳过：${skipped} 条`);
  console.log(`❌ 错误：${errors} 条`);
  console.log(`📦 总计：${chunks.length} 条`);

  if (!dryRun && migrated > 0) {
    console.log(`\n✅ 迁移完成！数据已保存到：${targetDbPath}`);
    console.log("\n📝 下一步操作:");
    console.log("   1. 验证迁移结果：openclaw memory stats");
    console.log("   2. 搜索测试：openclaw memory search \"关键词\"");
    console.log("   3. 如果一切正常，可以配置 OpenClaw 使用新系统");
  }

  if (dryRun) {
    console.log("\n🔍 这是 DRY RUN 模式，没有实际写入数据");
    console.log("   确认无误后，运行：node scripts/migrate-from-builtin.js");
  }

  // 清理
  sourceDb.close();
  
  if (!dryRun && db) {
    await db.close();
  }
}

// 执行迁移
migrate().catch(error => {
  console.error("\n❌ 迁移失败:", error.message);
  console.error(error.stack);
  process.exit(1);
});
