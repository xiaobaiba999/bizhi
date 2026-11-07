"use strict";

/**
 * electron-builder beforeBuild 钩子
 *
 * 桌面壳（release/app）不含任何原生依赖 —— Next 服务器在 extraResources 中
 * 自带完整的 standalone node_modules（含 Prisma 双平台引擎）。
 * 返回 false 告诉 electron-builder：node_modules 由外部处理，不要收集/重建，
 * 从而避免把整个 Web 项目的 node_modules 打进 asar。
 */
module.exports = async function beforeBuild() {
  return false;
};
