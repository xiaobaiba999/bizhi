/**
 * Next.js instrumentation —— 服务器进程启动时执行一次（register 钩子）。
 *
 * 数据库结构自动修补（v1.4.2 升级保护的核心一环）：
 * 旧版本数据库缺表（如 Blocked）、缺列（如 Download.quality）时自动补齐，
 * 已有记录原样保留、绝不重建；修补过程写运行日志（[db-schema] ...），
 * 桌面版可在主进程日志中看到（前缀 [server]）。
 */

/** 期望的数据库结构（与 prisma/schema.prisma 保持一致） */
const EXPECTED_TABLES: {
  name: string
  create: string
  index?: string
  columns: [string, string][]
}[] = [
  {
    name: "ZfToken",
    create: `CREATE TABLE IF NOT EXISTS "ZfToken" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "token" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
    index: `CREATE UNIQUE INDEX IF NOT EXISTS "ZfToken_token_key" ON "ZfToken"("token")`,
    columns: [
      ["id", "TEXT NOT NULL PRIMARY KEY"],
      ["token", "TEXT NOT NULL"],
      ["note", "TEXT NOT NULL"],
      ["createdAt", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"],
    ],
  },
  {
    name: "Download",
    create: `CREATE TABLE IF NOT EXISTS "Download" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "wtId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "src" TEXT NOT NULL,
  "quality" TEXT NOT NULL DEFAULT 'preview',
  "downloadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
    index: `CREATE UNIQUE INDEX IF NOT EXISTS "Download_wtId_key" ON "Download"("wtId")`,
    columns: [
      ["id", "TEXT NOT NULL PRIMARY KEY"],
      ["wtId", "TEXT NOT NULL"],
      ["title", "TEXT NOT NULL"],
      ["src", "TEXT NOT NULL"],
      ["quality", "TEXT NOT NULL DEFAULT 'preview'"],
      ["downloadedAt", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"],
    ],
  },
  {
    name: "Blocked",
    create: `CREATE TABLE IF NOT EXISTS "Blocked" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "wtId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "src" TEXT NOT NULL,
  "blockedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
    index: `CREATE UNIQUE INDEX IF NOT EXISTS "Blocked_wtId_key" ON "Blocked"("wtId")`,
    columns: [
      ["id", "TEXT NOT NULL PRIMARY KEY"],
      ["wtId", "TEXT NOT NULL"],
      ["title", "TEXT NOT NULL"],
      ["src", "TEXT NOT NULL"],
      ["blockedAt", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"],
    ],
  },
]

/**
 * SQLite ALTER TABLE ADD COLUMN 限制：不能加 PRIMARY KEY，
 * NOT NULL 列必须带 DEFAULT。这里把定义降级成 ALTER 可用的形式
 * （Prisma 写入时始终提供完整值，可空不影响功能）。
 */
function alterableColumnDef(def: string): string {
  if (/PRIMARY KEY/i.test(def)) return "TEXT"
  if (/NOT NULL/i.test(def) && !/DEFAULT/i.test(def)) {
    return def.replace(/\s*NOT NULL/i, "")
  }
  return def
}

async function patchDatabase() {
  const { PrismaClient } = await import("@prisma/client")
  const prisma = new PrismaClient({ log: ["error", "warn"] })
  try {
    for (const table of EXPECTED_TABLES) {
      const exists = await prisma.$queryRawUnsafe<{ cnt: number | bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='${table.name}'`
      )
      if (!exists[0] || Number(exists[0].cnt) === 0) {
        await prisma.$executeRawUnsafe(table.create)
        console.log(`[db-schema] table-created {"table":"${table.name}"}`)
      }

      // 补缺列（已有记录原样保留）
      const cols = await prisma.$queryRawUnsafe<{ name: string }[]>(
        `PRAGMA table_info("${table.name}")`
      )
      const have = new Set(cols.map((c) => c.name))
      for (const [column, def] of table.columns) {
        if (have.has(column)) continue
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "${table.name}" ADD COLUMN "${column}" ${alterableColumnDef(def)}`
        )
        console.log(`[db-schema] column-added {"table":"${table.name}","column":"${column}"}`)
      }

      // 补唯一索引（表已存在但索引缺失时；重复数据导致失败仅告警不动数据）
      if (table.index) {
        try {
          await prisma.$executeRawUnsafe(table.index)
        } catch (e) {
          console.warn(`[db-schema] index-skip {"table":"${table.name}","reason":"${String(e).slice(0, 160)}"}`)
        }
      }
    }
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
}

export async function register() {
  // 仅在 Node.js 运行时执行（边缘运行时无 Prisma）
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const url = process.env.DATABASE_URL
  if (!url || !url.startsWith("file:")) return

  try {
    await patchDatabase()
  } catch (e) {
    // 修补失败不阻断启动：路由仍可用现有结构工作
    console.error("[db-schema] patch-failed:", e)
  }
}
