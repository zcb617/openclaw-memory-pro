#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const SOURCE = join(homedir(), ".openclaw", "memory", "main.sqlite");
const TARGET = join(homedir(), ".openclaw", "memory", "lancedb-pro");

async function main() {
  console.log("🔄 重新迁移：SQLite → LanceDB-Pro\n");
  
  // 读取 SQLite
  const srcDb = new Database(SOURCE, { readonly: true });
  const chunks = srcDb.prepare("SELECT id, path, source, text, embedding, updated_at FROM chunks").all();
  console.log(`SQLite: ${chunks.length} 条`);
  
  // 连接 LanceDB
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.default.connect(TARGET);
  let table;
  
  try {
    table = await db.openTable("memories");
    const count = await table.countRows();
    console.log(`LanceDB 现有：${count} 条`);
    
    // 如果有数据，先清空
    if (count > 0) {
      console.log("⚠️  清空现有数据...\n");
      const all = await table.query().toArray();
      for (const row of all) {
        await table.delete(`id = '${row.id}'`);
      }
      const afterClear = await table.countRows();
      console.log(`清空后：${afterClear} 条\n`);
    }
  } catch (e) {
    console.log("创建新表...\n");
    const schema = { id: "__schema__", text: "", vector: Array(768).fill(0), category: "other", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: "{}" };
    table = await db.createTable("memories", [schema]);
    await table.delete('id = "__schema__"');
  }
  
  // 迁移数据
  console.log("开始迁移...\n");
  let success = 0;
  
  for (const chunk of chunks) {
    try {
      const vector = JSON.parse(chunk.embedding);
      if (!Array.isArray(vector) || vector.length < 100) continue;
      
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
          source: "builtin_v2",
          originalId: chunk.id,  // 用于去重
          originalPath: chunk.path,
          migratedAt: Date.now(),
        }),
      }]);
      success++;
      if (success % 50 === 0) console.log(`已迁移 ${success}/${chunks.length}`);
    } catch (e) {}
  }
  
  const final = await table.countRows();
  console.log("\n" + "=".repeat(50));
  console.log(`✅ 迁移完成！`);
  console.log(`   成功：${success} 条`);
  console.log(`   最终：${final} 条`);
  
  srcDb.close();
  await db.close();
}

main().catch(console.error);
