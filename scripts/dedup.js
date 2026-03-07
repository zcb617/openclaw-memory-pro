#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const TARGET_DB = join(homedir(), ".openclaw", "memory", "lancedb-pro");

async function main() {
  console.log("🗑️  删除重复记录...\n");
  
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.default.connect(TARGET_DB);
  const table = await db.openTable("memories");
  
  const all = await table.query().toArray();
  console.log(`当前总数：${all.length} 条`);
  
  const seen = new Map();
  const toDelete = [];
  
  all.forEach(row => {
    const id = row.id;
    if (seen.has(id)) {
      const existing = seen.get(id);
      if (row.timestamp > existing.timestamp) {
        toDelete.push(existing);
        seen.set(id, row);
      } else {
        toDelete.push(row);
      }
    } else {
      seen.set(id, row);
    }
  });
  
  console.log(`唯一记录：${seen.size} 条`);
  console.log(`重复记录：${toDelete.length} 条\n`);
  
  if (toDelete.length === 0) {
    console.log("✅ 没有重复！");
    await db.close();
    return;
  }
  
  console.log("开始删除...\n");
  let deleted = 0;
  
  for (const row of toDelete) {
    try {
      await table.delete(`id = '${row.id}'`);
      deleted++;
      if (deleted % 50 === 0) console.log(`已删除 ${deleted}/${toDelete.length}`);
    } catch (e) {}
  }
  
  const final = await table.countRows();
  console.log("\n" + "=".repeat(50));
  console.log(`✅ 去重完成！删除：${deleted} 条，剩余：${final} 条`);
  
  await db.close();
}

main().catch(console.error);
