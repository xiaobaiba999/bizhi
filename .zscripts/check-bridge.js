// 临时验证脚本（测完删）：检查 wwDesktop 桥是否被 preload 成功注入
const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-dev-shm-usage");
app.commandLine.appendSwitch("no-zygote");
const path = require("node:path");
// 复用 desktop 的协议安装
const APP_DIR = "/home/z/my-project/desktop";
const { protocol } = require("electron");
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.whenReady().then(async () => {
  protocol.handle("app", async (request) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response("NF", { status: 404 }); }
    if (!pathname || pathname === "/") pathname = "/index.html";
    const safe = path.normalize(pathname).replace(/^([/\\])+/, "");
    const filePath = path.join(APP_DIR, "renderer", safe);
    const fs = require("node:fs");
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response("NF", { status: 404 });
      const body = await fs.promises.readFile(filePath);
      const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };
      return new Response(body, { headers: { "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" } });
    } catch { return new Response("NF", { status: 404 }); }
  });
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { preload: path.join(APP_DIR, "preload.js"), contextIsolation: true, nodeIntegration: false } });
  await win.loadURL("app://local/index.html");
  await new Promise(r => setTimeout(r, 4000));
  const checks = await win.webContents.executeJavaScript(`({
    hasBridge: typeof window.wwDesktop === 'object' && window.wwDesktop !== null,
    hasInitialStore: typeof window.wwDesktop?.initialStore === 'string' || window.wwDesktop?.initialStore === null,
    hasPersist: typeof window.wwDesktop?.persistStore === 'function',
    hasSelectDir: typeof window.wwDesktop?.selectSaveDir === 'function',
    hasGetDir: typeof window.wwDesktop?.getSaveDir === 'function',
    saveDirBtn: document.body.innerText.includes('保存位置'),
    v148: document.body.innerText.includes('v1.4.8'),
  })`, true);
  console.log("[bridge-check]", JSON.stringify(checks));
  const dir = await win.webContents.executeJavaScript(`window.wwDesktop?.getSaveDir?.()`, true).catch(() => null);
  console.log("[bridge-check] getSaveDir 返回:", JSON.stringify(await Promise.resolve(dir)));
  app.exit(checks.hasBridge && checks.hasPersist && checks.hasSelectDir && checks.v148 ? 0 : 1);
});
