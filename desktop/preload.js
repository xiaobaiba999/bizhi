"use strict";

/**
 * 壁纸工坊 · 桌面版 preload
 * 仅向网页暴露最小的桌面能力（contextIsolation 开启，无 Node 能力泄漏）：
 * - 下载目录的获取 / 自选 / 恢复默认 / 打开 / 定位文件（调起磁盘文件管理器）
 * - 订阅「壁纸已保存」事件（下载完成后网页可提示保存位置）
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApp", {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.app || null,

  /** 下载保存目录（自选位置优先，默认系统「下载\壁纸工坊」），返回绝对路径字符串 */
  getDownloadDir: () => ipcRenderer.invoke("wf:get-download-dir"),

  /** 弹出系统「选择文件夹」对话框选择保存位置，返回 { ok, dir?, canceled?, error? } */
  chooseDownloadDir: () => ipcRenderer.invoke("wf:choose-download-dir"),

  /** 恢复默认下载目录（取消自选），返回 { ok, dir?, error? } */
  resetDownloadDir: () => ipcRenderer.invoke("wf:reset-download-dir"),

  /** 在系统文件管理器中打开下载目录，返回错误字符串（空串 = 成功） */
  openDownloadDir: () => ipcRenderer.invoke("wf:open-download-dir"),

  /** 在文件管理器中定位并选中某个已下载文件，返回错误字符串（空串 = 成功） */
  revealFile: (filePath) => ipcRenderer.invoke("wf:reveal-file", filePath),

  /**
   * 订阅「壁纸已保存到磁盘」事件；返回取消订阅函数。
   * 回调参数：{ path: 文件绝对路径, filename: 文件名 }
   */
  onDownloadDone: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("wf:download-done", listener);
    return () => ipcRenderer.removeListener("wf:download-done", listener);
  },
});
