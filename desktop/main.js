"use strict";

/**
 * 壁纸工坊 · 桌面版主进程（Electron）
 *
 * 职责：
 * 1. 以子进程方式内嵌运行 Next.js standalone 服务器（ELECTRON_RUN_AS_NODE）
 * 2. 首次运行时把安装包内置的空数据库模板复制到用户数据目录（%APPDATA%\壁纸工坊）
 * 3. 接住网页触发的壁纸下载，自动保存到系统「下载\壁纸工坊」目录（不弹保存框）
 * 4. 外部链接一律交给系统浏览器
 * 5. 卸载说明：安装目录由 NSIS 卸载器清理；用户数据目录（数据库）由
 *    nsis.deleteAppDataOnUninstall 在卸载时一并删除 → 干净卸载、无残留
 */

const { app, BrowserWindow, Menu, shell, session, dialog, Notification } = require("electron");
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

/** Next standalone 服务器目录 */
function serverDir() {
  if (IS_DEV) {
    return path.join(__dirname, "..", ".next-desktop", "standalone");
  }
  return path.join(process.resourcesPath, "app", "server");
}

/** 用户数据目录（Windows: %APPDATA%\壁纸工坊，卸载时由安装器清理） */
function dataDir() {
  return process.env.WF_DATA_DIR || app.getPath("userData");
}

/** 首次运行：复制安装包内置的空数据库模板（已含全部表结构） */
function ensureDatabase() {
  const dir = dataDir();
  dbPath = path.join(dir, "wallpaper.db");
  if (fs.existsSync(dbPath)) return dbPath;

  const template = IS_DEV
    ? path.join(__dirname, "..", "release", "resources", "empty.db")
    : path.join(process.resourcesPath, "app", "empty.db");

  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(template, dbPath);
  console.log("[desktop] 首次运行，已初始化数据库:", dbPath);
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

/** 下载目录：系统「下载\壁纸工坊」 */
function downloadDir() {
  let base;
  try {
    base = app.getPath("downloads");
  } catch {
    base = path.join(os.homedir(), "Downloads");
  }
  return path.join(base, "壁纸工坊");
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
          try {
            if (Notification.isSupported()) {
              new Notification({ title: "壁纸已保存", body: path.basename(target) }).show();
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

    try {
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
