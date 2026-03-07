#!/usr/bin/env node
/**
 * 增量迁移工具：SQLite → LanceDB-Pro
 * 自动检测已迁移记录，只迁移新增数据
 */

import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const SOURCE_DB = join(homedir(), ".openclaw", "memory", "main.sqlite");
const TARGET_DB = join(homedir(), ".openclaw", "memory", "lancedb-pro");

async function loadLanceDB() {
  return await import("@lancedb/lancedb");
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  
  console.log("🔄 增量迁移：SQLite → LanceDB-Pro\n");
  
  // 打开 SQLite
  const sourceDb = new Database(SOURCE_DB, { readonly: true });
  const chunks = sourceDb.prepare("SELECT id, path, source, text, embedding, updated_at FROM chunks ORDER BY updated_at DESC").all();
  console.log(`📊 SQLite 数据：${chunks.length} 条`);
  
  // 打开 LanceDB
  const lancedb = await loadLanceDB();
  const db = await lancedb.connect(TARGET_DB);
  const table = await db.openTable("memories");
  const existingCount = await table.countRows();
  console.log(`📊 LanceDB 现有：${existingCount} 条`);
  
  // 获取已迁移的 ID
  let migratedIds = new Set();
  if (!force) {
    const migrated = await table.query().where("metadata LIKE '%builtin_migration%'").toArray();
    migrated.forEach(row => {
      try {
        const meta = JSON.parse(row.metadata);
        if (meta.originalId) migratedIds.add(meta.originalId);
      } catch {}
    });
    console.log(`📊 已迁移过：${migratedIds.size} 条\n`);
  }
  
  // 过滤需要迁移的
  const toMigrate = force ? chunks : chunks.filter(c => !migratedIds.has(c.id));
  console.log(`📦 待迁移：${toMigrate.length} 条\n`);
  
  if (toMigrate.length === 0) {
    console.log("✅ 没有新数据需要迁移！");
    sourceDb.close();
    await db.close();
    return;
  }
  
  // 执行迁移
  let success = 0, skip = 0, errors = 0;
  
  for (const chunk of toMigrate) {
    try {
      const vector = JSON.parse(chunk.embedding);
      if (!Array.isArray(vector) || vector.length < 100) { skip++; continue; }
      
      let category = "other";
      if (chunk.path.includes("MEMORY.md") || chunk.path.startsWith("memory/")) category = "fact";
      else if (chunk.text.includes("偏好") || chunk.text.toLowerCase().includes("prefer")) category = "preference";
      else if (chunk.text.includes("决定")) category = "decision";
      
      await table.add([{
        id: `builtin_${chunk.id.slice(0, 16)}`,
        text: chunk.text,
        vector,
        category,
        scope: "global",
        importance: 0.7,
        timestamp: chunk.updated_at || Date.now(),
        metadata: JSON.stringify({
          source: "builtin_incremental",
          originalId: chunk.id,
          originalPath: chunk.path,
          migratedAt: Date.now(),
        }),
      }]);
      success++;
    } catch (e) {
      errors++;
    }
  }
  
  // 显示结果
  console.log("=".repeat(50));
  console.log("✅ 迁移完成！");
  console.log(`   成功：${success} 条`);
  console.log(`   跳过：${skip} 条`);
  console.log(`   错误：${errors} 条`);
  console.log(`   总计：${toMigrate.length} 条`);
  console.log(`\n📈 LanceDB 总记录：${existingCount + success} 条`);
  
  sourceDb.close();
  await db.close();
}

main().catch(console.error);
