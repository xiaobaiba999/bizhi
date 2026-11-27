/**
 * 壁纸工坊 · 永久下载历史（桌面主进程，CommonJS）
 * ============================================================
 * v2.0 阶段五：SQLite 持久化下载历史（sql.js —— 真实 SQLite 编译为 WASM，
 * 无原生编译依赖，asar 打包安全）。
 *
 * 数据文件：app.getPath('userData')/ww-history.db（真实 SQLite 库文件，
 * 可直接用任意 SQLite 工具打开；绝非临时目录/缓存目录，升级不清空）。
 *
 * 表结构（downloads）—— 每条成功记录的完整档案：
 *   id(wallpaperId, 唯一约束) / wtId / title / category / width / height /
 *   format / bytes / sha256 / savedPath / downloadedAt
 *
 * 铁律（与规格一致）：
 * - 只有文件完整保存且质量校验通过后，主进程才调用 addDownload 写入
 *   （单写者原则：主进程独占写，渲染层只读）；
 * - 每次写入即同步落盘（原子替换 tmp→rename，断电不伤旧库）；
 * - 用户手动删除本地文件不删记录：listDownloads 读时 stat 检测，
 *   fileExists=false 标记「文件已不存在」；
 * - 自动迁移旧版 ww-store.json 的下载记录（字段缺失按 null 保留）；
 * - 备份/恢复 = 整库文件复制（恢复前校验是合法 SQLite 库且有本表）。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** 恢复时间/备份校验用的表名 */
const TABLES = {
  downloads: `CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY,
    wtId TEXT,
    title TEXT NOT NULL,
    category TEXT,
    width INTEGER,
    height INTEGER,
    format TEXT,
    bytes INTEGER,
    sha256 TEXT,
    savedPath TEXT,
    downloadedAt INTEGER NOT NULL
  )`,
  blocked: `CREATE TABLE IF NOT EXISTS blocked (
    id TEXT PRIMARY KEY,
    title TEXT,
    src TEXT,
    wtId TEXT,
    createdAt INTEGER NOT NULL
  )`,
};

/** 单条下载记录（渲染层与主进程共享形状） */
const DOWNLOAD_FIELDS = [
  "id",
  "wtId",
  "title",
  "category",
  "width",
  "height",
  "format",
  "bytes",
  "sha256",
  "savedPath",
  "downloadedAt",
];

/**
 * 创建历史库模块。
 * @param deps
 *   - dbFile(): string            SQLite 库文件绝对路径（userData 下）
 *   - legacyStoreFile(): string   旧版 ww-store.json 路径（迁移源，可不存在）
 *   - log(line): void             运行日志（缺省 no-op）
 */
function createHistoryDb(deps) {
  const { dbFile, legacyStoreFile, log = () => {} } = deps;

  let SQL = null; // sql.js 构造器（懒加载）
  let db = null; // 内存中的 Database（磁盘的真源镜像）
  let readyPromise = null;

  /* ---------------- 初始化 + 迁移 ---------------- */

  async function ensureReady() {
    if (db) return true;
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      try {
        if (!SQL) {
          const initSqlJs = require("sql.js");
          // 打包后 wasm 位于 app.asar.unpacked（asarUnpack 配置）；
          // 开发环境在 node_modules 原位
          const candid = path.join(__dirname, "node_modules", "sql.js", "dist");
          const wasmDir = fs.existsSync(path.join(candid, "sql-wasm.wasm"))
            ? candid
            : candid.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
          SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) });
        }
        fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
        if (fs.existsSync(dbFile())) {
          db = new SQL.Database(fs.readFileSync(dbFile()));
        } else {
          db = new SQL.Database();
        }
        db.run(TABLES.downloads);
        db.run(TABLES.blocked);
        migrateLegacyStore();
        persistNow(); // 建表/迁移后立即落盘
        const n = countDownloadsSync();
        log(`下载历史库就绪：${dbFile()}（${n} 条记录）`);
        return true;
      } catch (e) {
        log(`下载历史库初始化失败（下载功能不受影响，历史不可用）：${e && e.stack ? e.stack : e}`);
        db = null;
        return false;
      } finally {
        readyPromise = null;
      }
    })();
    return readyPromise;
  }

  /** 旧版 ww-store.json downloads 数组 → SQLite（保留可用字段，不重复迁移） */
  function migrateLegacyStore() {
    try {
      if (!fs.existsSync(legacyStoreFile())) return;
      const store = JSON.parse(fs.readFileSync(legacyStoreFile(), "utf8"));
      const list = Array.isArray(store?.downloads) ? store.downloads : [];
      let moved = 0;
      for (const r of list) {
        if (!r || typeof r.id !== "string" || hasIdInternal(r.id)) continue;
        db.run(
          `INSERT INTO downloads (id, title, category, downloadedAt) VALUES (?, ?, ?, ?)`,
          [r.id, String(r.title || ""), null, Number(r.downloadedAt) || Date.now()]
        );
        moved += 1;
      }
      if (moved > 0) log(`已迁移旧版下载记录 ${moved} 条 → ww-history.db（字段缺失按未知保留）`);
    } catch (e) {
      log(`旧版下载记录迁移失败（忽略，不影响新记录）：${e && e.message ? e.message : e}`);
    }
  }

  function hasIdInternal(id) {
    const st = db.prepare("SELECT 1 FROM downloads WHERE id = ?");
    try {
      st.bind([id]);
      return st.step();
    } finally {
      st.free();
    }
  }

  /* ---------------- 落盘（原子替换） ---------------- */

  function persistNow() {
    if (!db) return false;
    try {
      const data = Buffer.from(db.export());
      const file = dbFile();
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      log(`下载历史落盘失败：${e && e.message ? e.message : e}`);
      return false;
    }
  }

  /* ---------------- 记录操作 ---------------- */

  /**
   * 写入/刷新一条下载记录（仅在校验通过、文件已保存后调用）。
   * 同 id 重复下载 = 刷新记录（保留最早 downloadedAt 不重要，取最新）。
   */
  async function addDownload(rec) {
    if (!(await ensureReady())) return false;
    if (!rec || typeof rec.id !== "string" || !rec.id) return false;
    const row = DOWNLOAD_FIELDS.map((f) =>
      f === "downloadedAt" ? Number(rec.downloadedAt) || Date.now() : rec[f] ?? null
    );
    db.run(
      `INSERT INTO downloads (${DOWNLOAD_FIELDS.join(", ")})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         wtId=excluded.wtId, title=excluded.title, category=excluded.category,
         width=excluded.width, height=excluded.height, format=excluded.format,
         bytes=excluded.bytes, sha256=excluded.sha256, savedPath=excluded.savedPath,
         downloadedAt=excluded.downloadedAt`,
      row
    );
    return persistNow(); // 每条记录立即同步落盘（下载是低频操作，换取最强持久性）
  }

  /** 全部已下载的 wallpaperId 集合（列表过滤用） */
  async function getDownloadIds() {
    if (!(await ensureReady())) return new Set();
    const out = new Set();
    const st = db.prepare("SELECT id FROM downloads");
    try {
      while (st.step()) out.add(st.getAsObject().id);
    } finally {
      st.free();
    }
    return out;
  }

  async function countDownloads() {
    if (!(await ensureReady())) return 0;
    return countDownloadsSync();
  }

  function countDownloadsSync() {
    if (!db) return 0;
    const r = db.exec("SELECT COUNT(*) FROM downloads");
    return r.length ? Number(r[0].values[0][0]) : 0;
  }

  function rowToRecord(o) {
    return {
      id: String(o.id),
      wtId: o.wtId ?? null,
      title: String(o.title ?? ""),
      category: o.category ?? null, // null = 旧记录未知分类
      width: o.width ?? null,
      height: o.height ?? null,
      format: o.format ?? null,
      bytes: o.bytes ?? null,
      sha256: o.sha256 ?? null,
      savedPath: o.savedPath ?? null,
      downloadedAt: Number(o.downloadedAt) || 0,
      /** 读时检测文件是否仍存在（用户手动删除 → false；路径未知 → null） */
      fileExists: o.savedPath ? fs.existsSync(o.savedPath) : null,
    };
  }

  /**
   * 下载记录列表（新→旧）。
   * @param filter.category "computer" | "phone" | null（null/缺省 = 全部）
   * @param filter.limit 上限（默认 500）
   */
  async function listDownloads(filter = {}) {
    if (!(await ensureReady())) return [];
    const cat = filter.category === "computer" || filter.category === "phone" ? filter.category : null;
    const limit = Math.min(Math.max(Number(filter.limit) || 500, 1), 5000);
    const sql = cat
      ? "SELECT * FROM downloads WHERE category = ? ORDER BY downloadedAt DESC LIMIT ?"
      : "SELECT * FROM downloads ORDER BY downloadedAt DESC LIMIT ?";
    const st = db.prepare(sql);
    const out = [];
    try {
      st.bind(cat ? [cat, limit] : [limit]);
      while (st.step()) out.push(rowToRecord(st.getAsObject()));
    } finally {
      st.free();
    }
    return out;
  }

  async function getRecord(id) {
    if (!(await ensureReady())) return null;
    const st = db.prepare("SELECT * FROM downloads WHERE id = ?");
    try {
      st.bind([String(id)]);
      return st.step() ? rowToRecord(st.getAsObject()) : null;
    } finally {
      st.free();
    }
  }

  /* ---------------- 备份 / 恢复 ---------------- */

  /** 备份整库到目标路径（先落盘再复制） */
  async function backupTo(targetPath) {
    if (!(await ensureReady())) return { ok: false, error: "历史库未就绪" };
    try {
      persistNow();
      fs.copyFileSync(dbFile(), String(targetPath));
      log(`下载历史已备份 → ${targetPath}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 从备份恢复整库（校验合法后原子替换，自动重载） */
  async function restoreFrom(sourcePath) {
    if (!(await ensureReady())) return { ok: false, error: "历史库未就绪" };
    try {
      const buf = fs.readFileSync(String(sourcePath));
      const probe = new SQL.Database(buf); // 非法文件会在这里抛错
      const has = probe.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='downloads'"
      );
      probe.close();
      if (!has.length) return { ok: false, error: "该文件不是壁纸工坊的历史备份（缺少 downloads 表）" };
      const file = dbFile();
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      db.close();
      db = new SQL.Database(fs.readFileSync(file));
      const n = countDownloadsSync();
      log(`下载历史已从备份恢复：${sourcePath}（${n} 条）`);
      return { ok: true, count: n };
    } catch (e) {
      return { ok: false, error: `恢复失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** 退出前兜底落盘 */
  function flush() {
    if (db) persistNow();
  }

  return {
    ensureReady,
    addDownload,
    getDownloadIds,
    countDownloads,
    listDownloads,
    getRecord,
    backupTo,
    restoreFrom,
    flush,
  };
}

module.exports = { createHistoryDb };
