"use strict";

/**
 * 壁纸工坊 · 桌面版 preload
 * 仅向网页暴露最小的桌面环境标记（contextIsolation 开启，无 Node 能力泄漏）
 */
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("desktopApp", {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.app || null,
});
