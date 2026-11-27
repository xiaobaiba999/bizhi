/**
 * 壁纸工坊 · Windows 桌面版主进程（Electron）
 * ============================================================
 * 架构：渲染层 = Next.js 静态导出产物（desktop/renderer/，由
 *       scripts/build-desktop.mjs 构建注入），静态模式直连哲风源站。
 *
 * 关键设计：
 * - app:// 自定义标准协议加载本地渲染层（而非 file://）：
 *   ① origin 固定为 app://local，localStorage 跨次启动稳定
 *   ② 绝对路径 /_next/... 按 http 语义解析，无需相对路径改写
 * - v1.4.8 记录文件真源：屏蔽记录同步镜像到 userData/ww-store.json
 *   （preload 桥双向同步；localStorage 损坏/丢失时从文件完整恢复），
 *   跨版本升级永不丢，退出前强制落盘；
 *   v2.0：下载历史升级为 SQLite（userData/ww-history.db，history-db.js），
 *   旧 ww-store.json 的下载记录自动迁移，屏蔽记录仍在 ww-store.json
 * - 下载保存（v2.0）：主进程 OriginalDownloadService（original-download.js）
 *   统一链路：本地记录检查 → 登录检查 → 官网元数据（含动态壁纸拒绝）→
 *   ALTCHA → getCompleteUrl 签名直链 → 原始字节 → 质量硬校验 → 直存 →
 *   写入 SQLite 历史。串行拟人节奏 + 官网风控熔断。
 *   旧 will-download 浏览器下载接管已移除（死代码：桌面版全部下载均由
 *   主进程直存，不再经过会话下载）
 * - 微信扫码登录（v1.4.9，zf-login.js）：主进程托管哲风壁纸微信登录
 *   全链路（二维码 dataURL → lp 长轮询 → 官网回调换令牌），令牌持久化在
 *   ww-settings.json；下载原图走「ALTCHA 人机验证 + getCompleteUrl」拿
 *   与官网完全一致的原图并直接写入保存目录（无令牌自动回退预览质量）
 * - 外链（target=_blank）一律走系统默认浏览器，不在应用内开新窗
 * - v1.4.10 崩溃可见化：全局 uncaughtException/unhandledRejection → 错误弹窗 +
 *   写 userData/logs/main.log；启动分步日志；登录模块加载失败自动降级不致命；
 *   渲染进程崩溃可一键重载；菜单「帮助 → 打开运行日志」
 * - 记忆窗口位置与大小（userData/window-state.json）
 */

"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const APP_DIR = __dirname;
const RENDERER_DIR = path.join(APP_DIR, "renderer");
const PRELOAD_JS = path.join(APP_DIR, "preload.js");
const ICON_PNG = path.join(APP_DIR, "build", "icon.png");
const APP_VERSION = require("./package.json").version;
const SAVE_DIR_NAME = "WallpaperWorkshop";
const SMOKE = process.env.WW_SMOKE === "1";

// 无头/容器环境（冒烟测试）需要关闭沙箱与 GPU（必须在 ready 前生效）
if (SMOKE) {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-dev-shm-usage"); // 容器常无 /dev/shm
  app.commandLine.appendSwitch("no-zygote"); // 容器 zygote mount ns 隔离会让 /tmp 不可见
}

/* ------------------- 运行日志 + 崩溃可见化（v1.4.10） ------------------- */

// Windows 通知需要 AUMID 与安装器快捷方式一致，否则可能不弹/图标不对
try {
  app.setAppUserModelId("io.github.xiaobaiba999.wallpaperworkshop");
} catch {
  /* 老系统无碍 */
}

const LOG_DIR = () => path.join(app.getPath("userData"), "logs");
const LOG_FILE = () => path.join(LOG_DIR(), "main.log");

/** 追加一行日志（userData/logs/main.log，超 256KB 环形截断保留后半） */
function log(line) {
  try {
    fs.mkdirSync(LOG_DIR(), { recursive: true });
    fs.appendFileSync(LOG_FILE(), `[${new Date().toISOString()}] ${line}\n`);
    try {
      if (fs.statSync(LOG_FILE()).size > 262_144) {
        const buf = fs.readFileSync(LOG_FILE());
        fs.writeFileSync(LOG_FILE(), buf.subarray(buf.length - 131_072));
      }
    } catch {
      /* 截断失败不影响主流程 */
    }
  } catch {
    /* 日志本身绝不抛错 */
  }
  if (SMOKE) console.log(`[ww] ${line}`);
}

/** 把任意异常序列化成可读文本 */
function errText(e) {
  return e && e.stack ? String(e.stack) : String(e);
}

// 全局异常：弹窗 + 日志（弹窗在 app ready 前也可用）
process.on("uncaughtException", (err) => {
  const text = errText(err);
  log(`FATAL uncaughtException: ${text}`);
  try {
    dialog.showErrorBox(
      "壁纸工坊遇到错误",
      `发生未处理的错误：\n\n${text.slice(0, 600)}\n\n` +
        `已写入运行日志：\n${LOG_FILE()}\n\n` +
        `若界面异常请重启应用；问题持续可把日志文件内容反馈给开发者。`
    );
  } catch {
    /* 极端环境下弹窗失败也不叠加崩溃 */
  }
});

process.on("unhandledRejection", (reason) => {
  log(`unhandledRejection: ${errText(reason)}`);
});

/* ------------------------------- 小工具 ------------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

const notFound = () =>
  new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/** 壁纸保存目录：用户自定义优先（settings 记忆）；默认「图片/WallpaperWorkshop」 */
function getSaveDir() {
  const custom = readSettings().saveDir;
  if (typeof custom === "string" && custom.trim()) {
    try {
      fs.mkdirSync(custom, { recursive: true });
      return custom;
    } catch {
      /* 自定义目录失效（被删/无权限）→ 回退默认 */
    }
  }
  const base = (() => {
    try {
      return app.getPath("pictures");
    } catch {
      return app.getPath("downloads");
    }
  })();
  const dir = path.join(base, SAVE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 同名不覆盖：存在则追加 (1) (2) … */
function uniqueSavePath(dir, filename) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  if (!fs.existsSync(candidate)) return candidate;
  for (let i = 1; i < 1000; i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${Date.now()}-${filename}`);
}

/* ----------------------- 记录真源与设置（v1.4.8） ----------------------- */

const USER_DATA = () => app.getPath("userData");
const STORE_FILE = () => path.join(USER_DATA(), "ww-store.json");
const SETTINGS_FILE = () => path.join(USER_DATA(), "ww-settings.json");

/** 记录真源写防抖：合并高频变更，退出前 flush 强制落盘 */
let pendingStoreJson = null;
let storeFlushTimer = null;

function flushStoreNow() {
  if (pendingStoreJson === null) return;
  const json = pendingStoreJson;
  pendingStoreJson = null;
  try {
    fs.mkdirSync(USER_DATA(), { recursive: true });
    const tmp = STORE_FILE() + ".tmp"; // 原子替换：写一半断电不伤旧文件
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, STORE_FILE());
  } catch (e) {
    log(`记录真源落盘失败：${errText(e)}`);
  }
}

function scheduleStoreFlush(json) {
  pendingStoreJson = String(json);
  if (storeFlushTimer) clearTimeout(storeFlushTimer);
  storeFlushTimer = setTimeout(flushStoreNow, 250);
  storeFlushTimer.unref?.();
}

/** 用户设置（当前仅保存目录；空对象 = 全部默认） */
function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

function writeSettings(s) {
  try {
    fs.mkdirSync(USER_DATA(), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2));
  } catch {
    /* 设置写失败仅影响记忆的自定义目录 */
  }
}

/** 记录真源 IPC（preload 启动时同步拉取快照） */
ipcMain.on("ww:read-store", (e) => {
  try {
    e.returnValue = fs.readFileSync(STORE_FILE(), "utf8");
  } catch {
    e.returnValue = null; // 尚无文件 → 渲染层从 localStorage 一次性迁移
  }
});

ipcMain.on("ww:write-store", (_e, json) => {
  if (typeof json === "string" && json.length < 20_000_000) scheduleStoreFlush(json);
});

ipcMain.handle("ww:get-save-dir", () => getSaveDir());

ipcMain.handle("ww:open-save-dir", () => shell.openPath(getSaveDir()));

/** 弹出目录选择框；用户确认则记住新目录并返回，取消返回 null */
async function chooseSaveDir(parentWin) {
  const r = await dialog.showOpenDialog(parentWin, {
    title: "选择壁纸保存位置",
    properties: ["openDirectory", "dontAddToRecent"],
    defaultPath: getSaveDir(),
  });
  const dir = r.canceled ? null : r.filePaths?.[0] || null;
  if (dir) writeSettings({ ...readSettings(), saveDir: dir });
  return dir;
}

ipcMain.handle("ww:select-save-dir", async () => {
  const [win] = BrowserWindow.getAllWindows();
  return chooseSaveDir(win);
});

/* ---------------- 扫码登录 + 原图下载（v2.0 模块化） ---------------- */

/**
 * 模块拆分（v2.0 阶段三）：
 * - zf-login.js：扫码登录 / 令牌存取与校验
 * - zf-certify.js：ALTCHA 人机验证（getCompleteUrl 前置）
 * - original-download.js：OriginalDownloadService（统一下载链路）
 * - history-db.js：SQLite 永久下载历史（userData/ww-history.db）
 * 任一模块加载失败只降级对应功能（界面明确提示），绝不拖死整个应用。
 */
let login = null;
let history = null;
let downloadService = null;
try {
  const { createLoginModule } = require("./zf-login.js");
  login = createLoginModule({ readSettings, writeSettings, log });
} catch (e) {
  login = null;
  log(`登录模块加载失败（浏览不受影响，仅扫码登录不可用）：${errText(e)}`);
}
try {
  const { createHistoryDb } = require("./history-db.js");
  history = createHistoryDb({
    dbFile: () => path.join(USER_DATA(), "ww-history.db"),
    legacyStoreFile: STORE_FILE,
    log,
  });
} catch (e) {
  history = null;
  log(`历史库模块加载失败（下载不受影响，仅历史记录不可用）：${errText(e)}`);
}
try {
  if (login && history) {
    const { createOriginalDownloadService } = require("./original-download.js");
    downloadService = createOriginalDownloadService({
      rawToken: () => login.rawToken(),
      getSaveDir,
      uniqueSavePath,
      history,
      log,
    });
  } else {
    log("下载服务未初始化（登录或历史模块缺失）");
  }
} catch (e) {
  downloadService = null;
  log(`下载服务加载失败：${errText(e)}`);
}

/** 登录 IPC 兜底包装：模块缺失时返回统一的降级结果 */
const loginCall = (method, fallback) => (_e, ...args) =>
  login ? login[method](...args) : Promise.resolve(fallback);

const LOGIN_DOWN = { error: "登录模块未能加载，请通过菜单「帮助 → 打开运行日志」查看原因" };

ipcMain.handle("ww:login-start", loginCall("loginStart", LOGIN_DOWN));

ipcMain.handle("ww:login-poll", loginCall("loginPoll", { status: "error", msg: LOGIN_DOWN.error }));

ipcMain.handle("ww:login-get-token", loginCall("getToken", null));

ipcMain.handle("ww:login-save-token", loginCall("saveToken", false));

ipcMain.handle("ww:login-clear-token", loginCall("clearToken", false));

ipcMain.handle("ww:login-verify", loginCall("verifyToken", { valid: null, msg: LOGIN_DOWN.error }));

/** 原图下载（OriginalDownloadService 统一链路） */
ipcMain.handle("ww:download-original", (_e, wp) =>
  downloadService
    ? downloadService.download(wp)
    : Promise.resolve({
        ok: false,
        reason: "error",
        msg: "下载服务未能加载，请通过菜单「帮助 → 打开运行日志」查看原因",
      })
);

/* ---------------- 下载历史 IPC（v2.0 阶段五） ---------------- */

const HISTORY_DOWN = { ok: false, error: "历史库未就绪" };

/** 历史记录列表（可按分类过滤，含文件存在检测） */
ipcMain.handle("ww:history-list", (_e, filter) =>
  history ? history.listDownloads(filter || {}) : Promise.resolve([])
);

/** 全部已下载 id 集合（列表「隐藏已下载」过滤用） */
ipcMain.handle("ww:history-ids", () =>
  history ? history.getDownloadIds() : Promise.resolve(new Set())
);

ipcMain.handle("ww:history-count", () =>
  history ? history.countDownloads() : Promise.resolve(0)
);

/** 打开本地文件（系统默认看图工具） */
ipcMain.handle("ww:history-open", (_e, savedPath) => {
  if (typeof savedPath !== "string" || !savedPath) return { ok: false, error: "路径无效" };
  if (!fs.existsSync(savedPath)) return { ok: false, error: "文件已被移动或删除" };
  return shell.openPath(savedPath).then((r) => (r ? { ok: false, error: r } : { ok: true }));
});

/** 在资源管理器中显示文件 */
ipcMain.handle("ww:history-reveal", (_e, savedPath) => {
  if (typeof savedPath !== "string" || !savedPath) return { ok: false, error: "路径无效" };
  if (!fs.existsSync(savedPath)) return { ok: false, error: "文件已被移动或删除" };
  shell.showItemInFolder(savedPath);
  return Promise.resolve({ ok: true });
});

/** 备份下载历史（弹保存框 → 整库复制） */
ipcMain.handle("ww:history-backup", async () => {
  if (!history) return HISTORY_DOWN;
  const [win] = BrowserWindow.getAllWindows();
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const r = await dialog.showSaveDialog(win, {
    title: "备份下载历史",
    defaultPath: path.join(app.getPath("downloads"), `ww-history-${stamp}.db`),
    filters: [{ name: "SQLite 数据库", extensions: ["db"] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  return history.backupTo(r.filePath);
});

/** 恢复下载历史（弹选择框 → 校验后整库替换） */
ipcMain.handle("ww:history-restore", async () => {
  if (!history) return HISTORY_DOWN;
  const [win] = BrowserWindow.getAllWindows();
  const r = await dialog.showOpenDialog(win, {
    title: "恢复下载历史（将替换当前记录）",
    properties: ["openFile"],
    filters: [{ name: "SQLite 数据库", extensions: ["db"] }],
  });
  if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true };
  const result = await history.restoreFrom(r.filePaths[0]);
  if (result.ok) {
    dialog
      .showMessageBox(win, {
        type: "info",
        title: "恢复完成",
        message: `下载历史已恢复（${result.count ?? "?"} 条记录）`,
        detail: `来源：${r.filePaths[0]}`,
        buttons: ["确定"],
      })
      .catch(() => {});
  }
  return result;
});

// 退出前强制把待写数据落盘（记录真源 + SQLite 历史）
app.on("before-quit", () => {
  flushStoreNow();
  if (history) history.flush();
});
app.on("will-quit", () => {
  flushStoreNow();
  if (history) history.flush();
});

/* --------------------------- app:// 协议（核心） --------------------------- */

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** 把 app://local/<path> 映射到 renderer/ 下的文件（防目录穿越） */
function installAppProtocol() {
  protocol.handle("app", async (request) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return notFound();
    }
    if (!pathname || pathname === "/") pathname = "/index.html";
    const safe = path.normalize(pathname).replace(/^([/\\])+/, "");
    const filePath = path.join(RENDERER_DIR, safe);
    // 目录穿越防护（path.join 已归一化，再校验前缀）
    if (filePath !== RENDERER_DIR && !filePath.startsWith(RENDERER_DIR + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return notFound();
      const body = await fs.promises.readFile(filePath);
      return new Response(body, {
        headers: { "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" },
      });
    } catch {
      return notFound();
    }
  });
}

/* ----------------------------- 窗口状态记忆 ----------------------------- */

const STATE_FILE = () => path.join(app.getPath("userData"), "window-state.json");

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    if (typeof s.x !== "number" || typeof s.y !== "number" || typeof s.width !== "number") return null;
    // 窗口至少部分落在某块显示器内，否则丢弃（拔了外接屏的场景）
    const { screen } = require("electron");
    const display = screen.getDisplayMatching({ x: s.x, y: s.y, width: s.width, height: s.height });
    const wa = display.workArea;
    const visible =
      s.x < wa.x + wa.width && s.x + s.width > wa.x && s.y < wa.y + wa.height && s.y + s.height > wa.y;
    return visible ? s : null;
  } catch {
    return null;
  }
}

function persistWindowState(win) {
  try {
    const b = win.getNormalBounds();
    if (b.width > 0 && b.height > 0) {
      fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
      fs.writeFileSync(STATE_FILE(), JSON.stringify(b));
    }
  } catch {
    /* 忽略：关闭时机竞争等 */
  }
}

/* -------------------------------- 菜单 -------------------------------- */

function buildMenu(win) {
  const openSaveDir = () => shell.openPath(getSaveDir());
  const about = () =>
    dialog.showMessageBox(win, {
      type: "info",
      title: "关于壁纸工坊",
      message: `壁纸工坊 v${APP_VERSION}`,
      detail: [
        "哲风壁纸实时获取与原图下载工具 · Windows 桌面版",
        "",
        `版本：v${APP_VERSION}（Electron ${process.versions.electron} / Chromium ${process.versions.chrome}）`,
        "保存位置可自定义（菜单「文件 → 选择保存位置…」），默认「图片 / WallpaperWorkshop」",
        "屏蔽 / 下载记录存应用本地数据文件，升级新版本不丢",
        "遇到问题：菜单「帮助 → 打开运行日志」可一键定位原因",
        "数据实时来自 haowallpaper.com（哲风壁纸），版权归原作者所有",
      ].join("\n"),
      buttons: ["确定", "打开 GitHub"],
      defaultId: 0,
      cancelId: 0,
    }).then(({ response }) => {
      if (response === 1) shell.openExternal("https://github.com/xiaobaiba999/bizhi/releases");
    });

  const template = [
    {
      label: "文件(F)",
      submenu: [
        { label: "微信扫码登录…", click: () => { const [w] = BrowserWindow.getAllWindows(); w?.webContents.send("ww:open-login"); } },
        { type: "separator" },
        { label: "打开保存文件夹", accelerator: "CmdOrCtrl+O", click: () => shell.openPath(getSaveDir()) },
        { label: "选择保存位置…", click: () => void chooseSaveDir(win) },
        { type: "separator" },
        { label: "重新加载", accelerator: "CmdOrCtrl+R", click: () => win.webContents.reload() },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "视图(V)",
      submenu: [
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { role: "resetZoom", label: "重置缩放" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        { role: "toggleDevTools", label: "开发者工具" },
      ],
    },
    {
      label: "帮助(H)",
      submenu: [
        { label: "关于壁纸工坊", click: about },
        {
          label: "打开运行日志",
          click: () => {
            try {
              fs.mkdirSync(LOG_DIR(), { recursive: true });
            } catch {
              /* 已存在或无权限 */
            }
            shell.openPath(LOG_DIR());
          },
        },
        { label: "数据来源：哲风壁纸官网", click: () => shell.openExternal("https://haowallpaper.com") },
        {
          label: "GitHub Releases（历史版本）",
          click: () => shell.openExternal("https://github.com/xiaobaiba999/bizhi/releases"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------ 主窗口 ------------------------------ */

function createWindow() {
  const saved = loadWindowState();
  const win = new BrowserWindow({
    width: saved?.width || 1280,
    height: saved?.height || 860,
    x: saved?.x,
    y: saved?.y,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: "#111113",
    autoHideMenuBar: true,
    icon: ICON_PNG,
    title: "壁纸工坊",
    webPreferences: {
      preload: PRELOAD_JS,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => {
    log("窗口 ready-to-show（界面已呈现）");
    win.show();
  });
  win.on("close", () => persistWindowState(win));
  win.on("closed", () => log("窗口已关闭"));

  // 渲染层文档加载完成（说明 app:// 协议与静态资源链路 OK）
  win.webContents.on("did-finish-load", () => log(`渲染层加载完成：${win.webContents.getURL()}`));

  // 渲染进程崩溃（GPU/内存等）：弹窗可一键重载，而不是白屏无响应
  win.webContents.on("render-process-gone", (_e, details) => {
    log(`渲染进程异常退出：${JSON.stringify(details)}`);
    dialog
      .showMessageBox(win, {
        type: "error",
        title: "界面异常",
        message: "壁纸工坊的界面进程意外退出了",
        detail: `原因：${details.reason}${details.exitCode !== undefined ? `（代码 ${details.exitCode}）` : ""}\n可选择重新加载继续使用。`,
        buttons: ["重新加载", "退出"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) win.webContents.reload();
        else win.close();
      })
      .catch(() => {});
  });

  // 外链（target=_blank / window.open）→ 系统默认浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // 主文档加载失败（本地资源，理论上罕见）：给一键重试
  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMain) => {
    if (!isMain || code === -3) return; // -3 = 用户取消
    dialog
      .showMessageBox(win, {
        type: "error",
        title: "页面加载失败",
        message: "渲染层加载失败",
        detail: `${desc}（代码 ${code}）`,
        buttons: ["重试", "忽略"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) win.webContents.reload();
      });
  });

  buildMenu(win);
  if (SMOKE) installSmoke(win);
  win.loadURL("app://local/index.html");
  return win;
}

/* ---------------------------- 无头冒烟测试 ---------------------------- */

/** WW_SMOKE=1 时：加载 → 等图片 → 截图 + JSON 报告 → 退出码 0/2/3 */
function installSmoke(win) {
  const report = { loaded: false, url: "", title: "", images: 0, imagesComplete: 0, sampleText: "" };
  const out = process.env.WW_SMOKE_OUT
    ? path.resolve(process.env.WW_SMOKE_OUT)
    : path.join(APP_DIR, "smoke-desktop.png");
  const die = setTimeout(() => {
    console.log(`[smoke] 超时未加载完成 ${JSON.stringify(report)}`);
    app.exit(3);
  }, 60_000).unref();

  win.webContents.on("did-finish-load", async () => {
    try {
      report.loaded = true;
      report.url = win.webContents.getURL();
      report.title = win.webContents.getTitle();
      // 最多等 40s 让图片进入并加载完成（源站抓取 + 网格渲染）
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await win.webContents
          .executeJavaScript(
            `(() => {
              const imgs = Array.from(document.querySelectorAll('img'));
              return {
                n: imgs.length,
                done: imgs.filter(im => im.complete && im.naturalWidth > 0).length,
                text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
              };
            })()`,
            true
          )
          .catch(() => null);
        if (s) {
          report.images = s.n;
          report.imagesComplete = s.done;
          report.sampleText = s.text;
        }
        if (report.images > 0 && report.imagesComplete >= Math.min(report.images, 8)) break;
      }
      // 登录弹窗链路验证（WW_SMOKE_LOGIN=1）：点击「扫码登录」→
      // 主进程 IPC 发起会话 → dataURL 二维码渲染 → 状态文案出现
      if (process.env.WW_SMOKE_LOGIN === "1") {
        try {
          await win.webContents.executeJavaScript(
            `(() => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('扫码登录'))?.click(); true; })()`,
            true
          );
          for (let i = 0; i < 25; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            const s = await win.webContents
              .executeJavaScript(
                `(() => {
                  const qr = document.querySelector('img[alt="微信扫码登录二维码"]');
                  return {
                    dialogOpen: !!document.querySelector('[role=dialog]'),
                    qrSrc: qr ? qr.src.slice(0, 30) : null,
                    qrLoaded: qr ? (qr.complete && qr.naturalWidth > 0) : false,
                    phaseText: (document.querySelector('[role=dialog]')?.innerText || '').slice(0, 80),
                  };
                })()`,
                true
              )
              .catch(() => null);
            if (s) report.login = s;
            if (s && s.qrLoaded) break;
          }
        } catch (e) {
          report.loginError = String(e && e.message ? e.message : e);
        }
      }
      // 下载行为验证（WW_SMOKE_DOWNLOAD=1，v1.4.13）：未登录点击「下载原图」
      // → 应弹「扫码登录」引导 toast，且绝不静默保存 890px 小图（保存目录
      // 文件数点击前后必须一致 —— 质量硬保证的直接证据）
      if (process.env.WW_SMOKE_DOWNLOAD === "1") {
        try {
          // 点击前后保存目录文件清单对比（目录可能不存在 = 0 文件）
          const listSaveDir = () => {
            try {
              return fs.readdirSync(getSaveDir()).sort();
            } catch {
              return [];
            }
          };
          const filesBefore = listSaveDir();
          // 先关掉可能开着的登录弹窗（ESC）
          await win.webContents.executeJavaScript(
            `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true; })()`,
            true
          );
          await new Promise((r) => setTimeout(r, 600));
          await win.webContents.executeJavaScript(
            `(() => { [...document.querySelectorAll("[aria-label*='下载原图']")][0]?.click(); true; })()`,
            true
          );
          await new Promise((r) => setTimeout(r, 2500));
          const filesAfter = listSaveDir();
          const s = await win.webContents
            .executeJavaScript(
              `(() => {
                const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]'));
                const saved = Array.from(document.querySelectorAll('a[download]'));
                return {
                  toastText: toasts.map(t => (t.innerText || '').replace(/\\s+/g, ' ')).join(' || ').slice(0, 200),
                  guideShown: toasts.some(t => (t.innerText || '').includes('扫码登录') || (t.innerText || '').includes('重新扫码')),
                  actionBtn: toasts.some(t => [...t.querySelectorAll('button')].some(b => b.textContent.includes('扫码'))),
                  anchorSaved: saved.length,
                };
              })()`,
              true
            )
            .catch(() => null);
          if (s) {
            s.filesBefore = filesBefore.length;
            s.filesAfter = filesAfter.length;
            // 质量硬保证：未登录不允许落盘任何文件（预览小图也不行）
            s.noFileSaved = filesBefore.length === filesAfter.length;
          }
          if (s) report.download = s;
        } catch (e) {
          report.downloadError = String(e && e.message ? e.message : e);
        }
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      report.screenshot = out;
    } catch (e) {
      report.error = String(e && e.message ? e.message : e);
    }
    clearTimeout(die);
    console.log(`[smoke] ${JSON.stringify(report)}`);
    const ok = report.loaded && report.images > 0 && report.imagesComplete > 0;
    app.exit(ok ? 0 : 2);
  });
}

/* ------------------------------- 生命周期 ------------------------------- */

log(`壁纸工坊 v${APP_VERSION} 主进程启动（Electron ${process.versions.electron}，平台 ${process.platform} ${process.arch}）`);

if (!app.requestSingleInstanceLock()) {
  log("未获得单实例锁：已有实例在运行，本次启动退出（若没看到窗口，请检查任务栏/后台是否残留壁纸工坊进程后重试）");
  app.quit();
} else {
  app.on("second-instance", () => {
    log("second-instance：聚焦已有窗口");
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    log("app ready：注册 app:// 协议");
    installAppProtocol();
    log("创建主窗口（app://local/index.html）");
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    log("所有窗口已关闭，退出应用");
    if (process.platform !== "darwin") app.quit();
  });
}
