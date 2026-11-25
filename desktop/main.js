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
 * - v1.4.8 记录文件真源：屏蔽/下载记录同步镜像到 userData/ww-store.json
 *   （preload 桥双向同步；localStorage 损坏/丢失时从文件完整恢复），
 *   跨版本升级永不丢，退出前强制落盘
 * - 下载接管（will-download）：壁纸自动保存到「图片/WallpaperWorkshop」，
 *   也支持用户自主选择保存目录（userData/ww-settings.json 记忆）；
 *   批量下载不弹对话框；完成弹系统通知，点击通知打开保存文件夹
 * - 微信扫码登录（v1.4.9，zf-login.js）：主进程托管哲风壁纸微信登录
 *   全链路（二维码 dataURL → lp 长轮询 → 官网回调换令牌），令牌持久化在
 *   ww-settings.json；下载原图走「ALTCHA 人机验证 + getCompleteUrl」拿
 *   与官网完全一致的原图并直接写入保存目录（无令牌自动回退预览质量）
 * - 外链（target=_blank）一律走系统默认浏览器，不在应用内开新窗
 * - 记忆窗口位置与大小（userData/window-state.json）
 */

"use strict";

const { app, BrowserWindow, Menu, dialog, Notification, ipcMain, protocol, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createLoginModule } = require("./zf-login.js");

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
  } catch {
    /* 落盘失败不影响界面（localStorage 仍为镜像） */
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

/* ---------------- 扫码登录 + 原图直存（v1.4.9，主进程托管） ---------------- */

/**
 * 登录模块（desktop/zf-login.js）：扫码登录 / 令牌存取 / 原图直存。
 * 令牌持久化在 userData/ww-settings.json（zfToken 字段），跨版本升级永不丢；
 * 原图直存串行队列，下载字节直接写入壁纸保存目录。
 */
const login = createLoginModule({
  readSettings,
  writeSettings,
  getSaveDir,
  uniqueSavePath,
});

ipcMain.handle("ww:login-start", () => login.loginStart());

ipcMain.handle("ww:login-poll", (_e, state) => login.loginPoll(state));

ipcMain.handle("ww:login-get-token", () => login.getToken());

ipcMain.handle("ww:login-save-token", (_e, token, source) => login.saveToken(token, source));

ipcMain.handle("ww:login-clear-token", () => login.clearToken());

ipcMain.handle("ww:login-verify", (_e, wtId) => login.verifyToken(wtId));

ipcMain.handle("ww:download-original", (_e, wtId, filename) => login.downloadOriginal(wtId, filename));

// 退出前强制把待写的记录真源落盘（防抖漏写兜底）
app.on("before-quit", flushStoreNow);
app.on("will-quit", flushStoreNow);

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

/* ------------------------------ 下载接管 ------------------------------ */

/** 下载会话：一批（单张或批量）进行中的计数 + 已存文件名，用于汇总通知 */
const dl = { active: 0, batch: 0, savedNames: [] };

function notifySaved() {
  const n = dl.batch;
  const dir = getSaveDir();
  const title = n === 1 ? "壁纸已保存" : `已保存 ${n} 张壁纸`;
  const names = dl.savedNames.slice(0, 3).join("、") + (dl.savedNames.length > 3 ? " 等" : "");
  try {
    if (Notification.isSupported()) {
      const note = new Notification({ title, body: `${names}\n保存位置：${dir}`, timeoutType: "never" });
      note.on("click", () => shell.openPath(dir));
      note.show();
    }
  } catch {
    /* 通知失败不影响下载 */
  }
}

function installDownloadHandler() {
  session.defaultSession.on("will-download", (_event, item) => {
    const dir = getSaveDir();
    const filename = item.getFilename() || `wallpaper-${Date.now()}.png`;
    item.setSavePath(uniqueSavePath(dir, filename));
    if (dl.active === 0) {
      dl.batch = 0;
      dl.savedNames = [];
    }
    dl.active += 1;
    dl.batch += 1;
    dl.savedNames.push(filename);
    item.on("done", (_e, state) => {
      dl.active -= 1;
      if (state !== "completed" && dl.savedNames.includes(filename)) {
        dl.savedNames = dl.savedNames.filter((f) => f !== filename);
        dl.batch -= 1;
      }
      if (dl.active <= 0) {
        dl.active = 0;
        if (dl.batch > 0) notifySaved();
        dl.batch = 0;
      }
    });
  });
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

  win.once("ready-to-show", () => win.show());
  win.on("close", () => persistWindowState(win));

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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    installAppProtocol();
    installDownloadHandler();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
