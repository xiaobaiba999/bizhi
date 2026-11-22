/**
 * 壁纸工坊 · 桌面版 preload（渲染层 ⇆ 主进程桥）
 * ============================================================
 * v1.4.8 起屏蔽 / 下载记录以 userData/ww-store.json 为唯一真源（文件级持久，
 * 跨版本升级、localStorage 损坏都不丢）。本桥职责：
 * - initialStore：启动时同步读一次文件真源（null = 文件不存在 → 渲染层把
 *   localStorage 里的旧记录一次性迁移进文件，此后 localStorage 降级为镜像）
 * - persistStore：渲染层每次变更后防抖全量落盘（fire-and-forget）
 * - getSaveDir / selectSaveDir / openSaveDir：壁纸保存位置「自主选择」
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
});
