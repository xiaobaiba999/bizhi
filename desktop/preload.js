/**
 * 壁纸工坊 · 桌面版 preload（渲染层 ⇆ 主进程桥）
 * ============================================================
 * v1.4.8 起屏蔽 / 下载记录以 userData/ww-store.json 为唯一真源（文件级持久，
 * 跨版本升级、localStorage 损坏都不丢）。本桥职责：
 * - initialStore：启动时同步读一次文件真源（null = 文件不存在 → 渲染层把
 *   localStorage 里的旧记录一次性迁移进文件，此后 localStorage 降级为镜像）
 * - persistStore：渲染层每次变更后防抖全量落盘（fire-and-forget）
 * - getSaveDir / selectSaveDir / openSaveDir：壁纸保存位置「自主选择」
 * - loginStart / loginPoll / loginGetToken / loginSaveToken / loginClearToken /
 *   loginVerify / downloadOriginal（v1.4.9）：微信扫码登录与原图直存，
 *   全部由主进程托管（Node 环境无 CORS 限制），令牌持久化在 ww-settings.json
 *
 * 安全：contextIsolation 隔离下仅暴露以下只读/受控方法，页面拿不到 Node 能力。
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/** 启动快照：同步问主进程要 ww-store.json 原文（一次性，几十 KB 内） */
const initialStore = ipcRenderer.sendSync("ww:read-store");

contextBridge.exposeInMainWorld("wwDesktop", {
  /** string | null：文件真源 JSON 原文（null = 尚无文件，需要迁移） */
  initialStore,
  /** 全量写文件真源（主进程侧防抖合并，退出前强制 flush） */
  persistStore(json) {
    ipcRenderer.send("ww:write-store", String(json));
  },
  /** 当前壁纸保存目录（默认「图片/WallpaperWorkshop」，可被用户自定义） */
  getSaveDir() {
    return ipcRenderer.invoke("ww:get-save-dir");
  },
  /** 弹出目录选择框；返回新目录或 null（用户取消） */
  selectSaveDir() {
    return ipcRenderer.invoke("ww:select-save-dir");
  },
  /** 在系统资源管理器中打开保存目录 */
  openSaveDir() {
    return ipcRenderer.invoke("ww:open-save-dir");
  },

  /* ---------------- 扫码登录 + 原图下载（v1.4.9） ---------------- */

  /** 发起扫码会话；成功返回 { state, qrDataUrl }，失败返回 { error } */
  loginStart() {
    return ipcRenderer.invoke("ww:login-start");
  },
  /** 轮询扫码状态（pending / scanned / ok / expired / error） */
  loginPoll(state) {
    return ipcRenderer.invoke("ww:login-poll", state);
  },
  /** 已存令牌（脱敏）；无令牌返回 null */
  loginGetToken() {
    return ipcRenderer.invoke("ww:login-get-token");
  },
  /** 保存令牌（扫码自动 / 手动粘贴） */
  loginSaveToken(token, source) {
    return ipcRenderer.invoke("ww:login-save-token", token, source);
  },
  /** 删除令牌 */
  loginClearToken() {
    return ipcRenderer.invoke("ww:login-clear-token");
  },
  /** 官网实测令牌是否仍有效（true / false / null 无法判定） */
  loginVerify(wtId) {
    return ipcRenderer.invoke("ww:login-verify", wtId);
  },
  /** 原图直存：主进程 ALTCHA + getCompleteUrl + 下载写入保存目录 */
  downloadOriginal(wtId, filename) {
    return ipcRenderer.invoke("ww:download-original", wtId, filename);
  },
  /** 菜单「微信扫码登录…」点击：通知渲染层打开登录弹窗 */
  onOpenLogin(callback) {
    ipcRenderer.on("ww:open-login", () => callback());
  },
});
