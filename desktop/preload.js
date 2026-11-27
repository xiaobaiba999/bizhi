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

  /* ---------------- 扫码登录 + 原图下载（v2.0） ---------------- */

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
  /**
   * 原图下载（OriginalDownloadService 统一链路）：
   * 主进程 本地记录检查 → 登录检查 → 元数据（动态拒绝）→ ALTCHA →
   * getCompleteUrl 签名直链 → 原始字节 → 质量硬校验 → 直存 → 写 SQLite 历史。
   * @param wp { id, wtId?, title, category? } 统一壁纸模型
   */
  downloadOriginal(wp) {
    return ipcRenderer.invoke("ww:download-original", wp);
  },
  /** 菜单「微信扫码登录…」点击：通知渲染层打开登录弹窗 */
  onOpenLogin(callback) {
    ipcRenderer.on("ww:open-login", () => callback());
  },

  /* ---------------- 下载历史（v2.0 SQLite） ---------------- */

  /** 历史记录列表（新→旧，含 fileExists 检测；filter: {category?} ） */
  historyList(filter) {
    return ipcRenderer.invoke("ww:history-list", filter || {});
  },
  /** 全部已下载 id 集合（列表「隐藏已下载」过滤用） */
  historyIds() {
    return ipcRenderer.invoke("ww:history-ids");
  },
  /** 历史记录条数 */
  historyCount() {
    return ipcRenderer.invoke("ww:history-count");
  },
  /** 用系统默认看图工具打开本地文件 */
  historyOpenFile(savedPath) {
    return ipcRenderer.invoke("ww:history-open", savedPath);
  },
  /** 在资源管理器中显示文件 */
  historyRevealFile(savedPath) {
    return ipcRenderer.invoke("ww:history-reveal", savedPath);
  },
  /** 备份下载历史（弹保存框 → 整库 .db 复制） */
  historyBackup() {
    return ipcRenderer.invoke("ww:history-backup");
  },
  /** 恢复下载历史（弹选择框 → 校验后整库替换） */
  historyRestore() {
    return ipcRenderer.invoke("ww:history-restore");
  },
});
