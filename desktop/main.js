"use strict";

/**
 * 壁纸工坊 · 桌面版主进程（Electron）
 *
 * 职责：
 * 1. 以子进程方式内嵌运行 Next.js standalone 服务器（ELECTRON_RUN_AS_NODE）
 * 2. 首次运行时把安装包内置的空数据库模板复制到用户数据目录（%APPDATA%\壁纸工坊）
 *    —— 已存在的数据库只要是有效 SQLite 文件就原样保留，永不因缺表/缺列重建
 *    （缺表缺列由服务端启动时自动修补，见 src/instrumentation.ts）
 * 3. 启动时自恢复「升级护送」的用户数据（安装器崩溃/中断时的兑底，见 build/installer.nsh）
 * 4. 接住网页触发的壁纸下载，自动保存到系统「下载\壁纸工坊」目录（不弹保存框）
 * 5. 外部链接一律交给系统浏览器
 * 6. 卸载说明：安装目录由 NSIS 卸载器清理；用户数据目录（数据库/屏蔽记录）
 *    仅在卸载向导中主动勾选「同时删除应用数据」时才删除 → 正常卸载不丢数据
 */

const { app, BrowserWindow, Menu, shell, session, dialog, Notification, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const os = require("node:os");

const IS_DEV = !app.isPackaged;
const APP_NAME = "壁纸工坊";
const DEFAULT_PORT = Number(process.env.WF_PORT) || 41723;
const APP_ID = "com.wallpaperworkshop.app";

// Linux 容器/root 环境跑冒烟测试需要
try {
  if (process.env.WF_NO_SANDBOX === "1" || (process.getuid && process.getuid() === 0)) {
    app.commandLine.appendSwitch("no-sandbox");
  }
  if (process.env.WF_DISABLE_GPU === "1") {
    app.commandLine.appendSwitch("disable-gpu");
  }
} catch {
  /* ignore */
}

app.setAppUserModelId(APP_ID);

let win = null;
let serverProc = null;
let currentPort = DEFAULT_PORT;
let dbPath = "";
let quitting = false;

/* ---------------- 路径与数据库 ---------------- */

/** Next standalone 服务器目录（WF_SERVER_DIR 可覆盖，便于开发/冒烟测试直接指向打包布局） */
function serverDir() {
  if (process.env.WF_SERVER_DIR) return process.env.WF_SERVER_DIR;
  if (IS_DEV) {
    return path.join(__dirname, "..", ".next-desktop", "standalone");
  }
  return path.join(process.resourcesPath, "app", "server");
}

/** 用户数据目录（Windows: %APPDATA%\壁纸工坊，卸载时由安装器清理） */
function dataDir() {
  return process.env.WF_DATA_DIR || app.getPath("userData");
}

/* ---------------- 设置持久化（自选下载位置等） ---------------- */

function settingsPath() {
  return path.join(dataDir(), "settings.json");
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) || {};
  } catch {
    return {};
  }
}

function writeSettings(obj) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("[desktop] 写入设置失败:", e);
  }
}

/** 用户自选的下载目录（未设置返回 null） */
function chosenDownloadDir() {
  const dir = readSettings().downloadDir;
  return typeof dir === "string" && dir.trim() ? dir.trim() : null;
}

/**
 * 恢复「升级护送」的用户数据（兜底）：新安装器升级时会把用户数据目录改名转移到
 * 壁纸工坊.wf-upgrade-backup，旧版卸载完成后再放回；被中断遗留的副本停放于
 * 壁纸工坊.wf-upgrade-parked。这里在应用启动时自动处置 —— 无论中间出了什么
 * 状况（安装器崩溃 / 用户取消安装），数据都不会丢：
 *  - 数据目录缺失或仅空壳库（体积 ≤ 空模板）→ 恢复护送副本；
 *  - 现库已有真实数据（体积超过空模板）→ 副本视为陈旧残留，清理。
 */
function restoreEscortedData() {
  try {
    const dir = dataDir();
    const dbInDir = path.join(dir, "wallpaper.db");
    const template = IS_DEV
      ? path.join(__dirname, "..", "release", "resources", "empty.db")
      : path.join(process.resourcesPath, "app", "empty.db");
    // 空模板库的体积基线：现库超过它即视为有真实数据（SQLite 按页增长）
    const freshLimit = fs.existsSync(template) ? fs.statSync(template).size : 40960;
    const dirHasRealData =
      fs.existsSync(dbInDir) && fs.statSync(dbInDir).size > freshLimit;

    for (const suffix of [".wf-upgrade-backup", ".wf-upgrade-parked"]) {
      const candidate = dir + suffix;
      const dbInCandidate = path.join(candidate, "wallpaper.db");
      if (!fs.existsSync(dbInCandidate)) continue;

      if (!fs.existsSync(dbInDir) || !dirHasRealData) {
        // 数据目录缺失 / 仅空壳库 → 恢复护送副本
        if (fs.existsSync(dir)) {
          // 空壳目录挪走，护送副本归位
          const hollow = dir + ".hollow-" + Date.now();
          fs.renameSync(dir, hollow);
          fs.renameSync(candidate, dir);
          fs.rmSync(hollow, { recursive: true, force: true });
        } else {
          fs.renameSync(candidate, dir);
        }
        console.log("[desktop] 升级护送的用户数据已恢复:", dir);
        return;
      }

      // 现库有真实数据 → 副本为陈旧残留，清理
      fs.rmSync(candidate, { recursive: true, force: true });
      console.log("[desktop] 清理陈旧护送残留:", candidate);
    }
  } catch (e) {
    console.error("[desktop] 恢复护送数据失败:", e);
  }
}

/** SQLite 文件头魔数（前 16 字节）：有效即保留，绝不因缺表/缺列重建 */
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

function isValidSqlite(dbFile) {
  try {
    const fd = fs.openSync(dbFile, "r");
    try {
      const head = Buffer.alloc(16);
      const n = fs.readSync(fd, head, 0, 16, 0);
      return n === 16 && head.equals(SQLITE_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * 首次运行：复制安装包内置的空数据库模板（已含全部表结构）。
 * 升级运行：数据库文件只要是有效 SQLite 就原样保留 —— 缺表/缺列由服务端
 * 启动时自动修补（instrumentation），旧记录一条不丢；
 * 仅真正损坏（非 SQLite 文件）时备份后重建。
 */
function ensureDatabase() {
  const dir = dataDir();
  dbPath = path.join(dir, "wallpaper.db");

  const template = IS_DEV
    ? path.join(__dirname, "..", "release", "resources", "empty.db")
    : path.join(process.resourcesPath, "app", "empty.db");

  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(dbPath)) {
    if (isValidSqlite(dbPath)) return dbPath; // 有效 → 永不重建（结构问题交给服务端自动修补）
    // 真正损坏（非 SQLite 文件）：备份后重建
    const backup = path.join(dir, `wallpaper.db.bak-${Date.now()}`);
    try {
      fs.copyFileSync(dbPath, backup);
      console.log(`[desktop] 数据库文件损坏，旧文件备份至 ${backup}`);
    } catch (e) {
      console.error("[desktop] 备份损坏数据库失败（将继续重建）:", e);
    }
    try {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(path.join(dir, "wallpaper.db-journal"), { force: true });
      fs.rmSync(path.join(dir, "wallpaper.db-wal"), { force: true });
      fs.rmSync(path.join(dir, "wallpaper.db-shm"), { force: true });
    } catch (e) {
      console.error("[desktop] 清理损坏数据库文件失败:", e);
    }
  }

  fs.copyFileSync(template, dbPath);
  console.log("[desktop] 数据库已初始化:", dbPath);
  return dbPath;
}

/* ---------------- 内嵌 Next 服务器 ---------------- */

/** 挑一个空闲端口（优先默认端口，失败则顺延/回退随机） */
function pickPort(preferred) {
  return new Promise((resolve) => {
    const tryNext = (i) => {
      const port = preferred + i;
      const srv = net.createServer();
      const onErr = () => {
        srv.close();
        if (i < 4) tryNext(i + 1);
        else {
          const rnd = net.createServer();
          rnd.listen(0, "127.0.0.1", () => {
            const p = rnd.address().port;
            rnd.close(() => resolve(p));
          });
        }
      };
      srv.once("error", onErr);
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(port)));
    };
    tryNext(0);
  });
}

function startServer(port) {
  const dir = serverDir();
  const entry = path.join(dir, "server.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`未找到内嵌服务器: ${entry}`);
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    // Prisma SQLite 绝对路径（Windows 下用正斜杠）
    DATABASE_URL: "file:" + dbPath.replace(/\\/g, "/"),
  };

  console.log(`[desktop] 启动内嵌服务器 127.0.0.1:${port}，数据库 ${dbPath}`);
  serverProc = spawn(process.execPath, [entry], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProc.stdout.on("data", (d) => process.stdout.write("[server] " + d));
  serverProc.stderr.on("data", (d) => process.stderr.write("[server] " + d));

  serverProc.once("exit", (code) => {
    console.error(`[desktop] 内嵌服务器退出 code=${code}`);
    serverProc = null;
    if (!quitting && win && !win.isDestroyed()) {
      // 意外崩溃：自动重启一次并刷新窗口
      void restartServer();
    }
  });
}

async function restartServer() {
  try {
    const port = await pickPort(DEFAULT_PORT);
    startServer(port);
    await waitForServer(port, 30000);
    currentPort = port;
    if (win && !win.isDestroyed()) await win.loadURL(`http://127.0.0.1:${port}/`);
  } catch (e) {
    dialog.showErrorBox(APP_NAME, "本地服务启动失败，应用即将退出。\n" + (e?.message || e));
    app.quit();
  }
}

/** 轮询等待服务器就绪 */
function waitForServer(port, timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      if (serverProc && serverProc.exitCode !== null) {
        return reject(new Error("内嵌服务器进程启动失败，请查看日志"));
      }
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) return reject(new Error("内嵌服务器启动超时"));
        setTimeout(ping, 300);
      });
    };
    ping();
  });
}

/* ---------------- 窗口 / 下载 / 外链 ---------------- */

function isLocalUrl(url, port) {
  return (
    url.startsWith(`http://127.0.0.1:${port}`) || url.startsWith(`http://localhost:${port}`)
  );
}

/** 下载目录：用户自选位置优先，默认系统「下载\壁纸工坊」 */
function downloadDir() {
  const chosen = chosenDownloadDir();
  if (chosen) {
    try {
      fs.mkdirSync(chosen, { recursive: true });
      return chosen;
    } catch (e) {
      console.error("[desktop] 自选下载目录不可用，回退默认:", e);
    }
  }
  let base;
  try {
    base = app.getPath("downloads");
  } catch {
    base = path.join(os.homedir(), "Downloads");
  }
  return path.join(base, "壁纸工坊");
}

/** 网页 → 主进程 IPC：获取/选择/恢复下载目录、打开目录、定位已下载文件（调起磁盘文件管理器） */
function setupIpc() {
  ipcMain.handle("wf:get-download-dir", () => {
    try {
      return downloadDir();
    } catch (e) {
      return "";
    }
  });

  /** 弹出系统「选择文件夹」对话框；确认后持久化并返回新目录 */
  ipcMain.handle("wf:choose-download-dir", async () => {
    try {
      const result = await dialog.showOpenDialog(win, {
        title: "选择壁纸保存位置",
        defaultPath: downloadDir(),
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      const dir = result.filePaths[0];
      fs.mkdirSync(dir, { recursive: true });
      const settings = readSettings();
      settings.downloadDir = dir;
      writeSettings(settings);
      console.log("[desktop] 下载位置已更新:", dir);
      return { ok: true, dir };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  /** 恢复默认下载目录（取消自选） */
  ipcMain.handle("wf:reset-download-dir", () => {
    try {
      const settings = readSettings();
      delete settings.downloadDir;
      writeSettings(settings);
      return { ok: true, dir: downloadDir() };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle("wf:open-download-dir", () => {
    try {
      const dir = downloadDir();
      fs.mkdirSync(dir, { recursive: true });
      const err = shell.openPath(dir);
      if (err) console.error("[desktop] 打开下载目录失败:", err);
      return err || "";
    } catch (e) {
      return String((e && e.message) || e);
    }
  });

  ipcMain.handle("wf:reveal-file", (_event, filePath) => {
    try {
      // 仅允许定位下载目录内的文件，避免网页探测任意磁盘路径
      const dir = path.resolve(downloadDir());
      const target = path.resolve(String(filePath || ""));
      if (target !== dir && !target.startsWith(dir + path.sep)) return "invalid path";
      if (!fs.existsSync(target)) return "not found";
      shell.showItemInFolder(target);
      return "";
    } catch (e) {
      return String((e && e.message) || e);
    }
  });
}

/** 重名文件自动追加序号：name (1).ext */
function uniquePath(dir, filename) {
  let target = path.join(dir, filename);
  if (!fs.existsSync(target)) return target;
  const dot = filename.lastIndexOf(".");
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? "" : filename.slice(dot);
  for (let i = 1; i < 999; i++) {
    target = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(target)) return target;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/** 接住网页的 attachment 下载，静默保存（批量下载 18 张也不会弹 18 次保存框） */
function setupDownloads() {
  session.defaultSession.on("will-download", (event, item) => {
    try {
      const dir = downloadDir();
      fs.mkdirSync(dir, { recursive: true });
      const filename = item.getFilename() || "wallpaper.png";
      const target = uniquePath(dir, filename);
      item.setSavePath(target);
      item.once("done", (_e, state) => {
        console.log(`[desktop] 下载${state === "completed" ? "完成" : "中断"}: ${target}`);
        if (state === "completed") {
          // 推送给网页：弹「已保存 + 打开文件夹」提示（网页层做防抖合并）
          try {
            if (win && !win.isDestroyed()) {
              win.webContents.send("wf:download-done", {
                path: target,
                filename: path.basename(target),
              });
            }
          } catch {
            /* ignore */
          }
          try {
            if (Notification.isSupported()) {
              new Notification({
                title: "壁纸已保存",
                body: `${path.basename(target)}\n保存位置：${downloadDir()}`,
              }).show();
            }
          } catch {
            /* ignore */
          }
        }
      });
    } catch (e) {
      console.error("[desktop] 处理下载失败:", e);
    }
  });
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 480,
    minHeight: 640,
    show: false,
    backgroundColor: "#ffffff",
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // 拦截外部链接 → 系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !isLocalUrl(url, port)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (/^https?:\/\//i.test(url) && !isLocalUrl(url, port)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // 冒烟测试钩子：加载完成后截图并退出
  if (process.env.WF_SNAPSHOT) {
    const file = path.resolve(process.env.WF_SNAPSHOT);
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(file, img.toPNG());
          console.log("[desktop] 截图已保存:", file);
        } catch (e) {
          console.error("[desktop] 截图失败:", e);
        }
        // 桌面桥接探针：验证 preload + IPC 全链路（getDownloadDir 走主进程）
        try {
          const probe = await win.webContents.executeJavaScript(
            `(async () => {
               const api = window.desktopApp;
               if (!api) return { bridge: false };
               const dir = await api.getDownloadDir();
               const open = typeof api.chooseDownloadDir === "function";
               return { bridge: true, chooseDialog: open, dir: String(dir) };
             })()`,
            true
          );
          console.log("[desktop] 桥接探针:", JSON.stringify(probe));
        } catch (e) {
          console.error("[desktop] 桥接探针失败:", e);
        }
        setTimeout(() => app.exit(0), 400);
      }, 3000);
    });
  }

  void win.loadURL(`http://127.0.0.1:${port}/`);

  win.on("closed", () => {
    win = null;
  });
}

/* ---------------- 生命周期 ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    setupDownloads();
    setupIpc();

    try {
      restoreEscortedData();
      ensureDatabase();
      currentPort = await pickPort(DEFAULT_PORT);
      startServer(currentPort);
      await waitForServer(currentPort);
      createWindow(currentPort);
    } catch (e) {
      dialog.showErrorBox(APP_NAME, "应用启动失败，请重新安装或联系开发者。\n" + (e?.message || e));
      app.quit();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(currentPort);
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    if (serverProc) {
      try {
        serverProc.kill();
      } catch {
        /* ignore */
      }
      serverProc = null;
    }
  });
}
