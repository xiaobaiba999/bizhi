#!/usr/bin/env node
/**
 * electron-builder Linux 构建 Windows NSIS 修复补丁（幂等）
 *
 * 背景：electron-builder 26.x 在 Linux 上构建 NSIS 安装包时，提取内嵌
 * 卸载程序这一步默认调用 wine 运行安装器（spawn wine ENOENT 失败）。
 * 但同文件里 macOS Catalina 分支用的是 UninstallerReader —— 纯 JS 的
 * PE 解析器，静态提取卸载程序，无需任何执行环境。
 *
 * 本补丁把非 Catalina 分支的 wine 调用同样替换为 UninstallerReader.exec，
 * 使 Linux（无 wine）也能完整构建 Windows NSIS 安装包。
 *
 * 用法：node scripts/patch-electron-builder-linux.mjs   （build-desktop.mjs 自动调用）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(
  ROOT,
  "desktop",
  "node_modules",
  "app-builder-lib",
  "out",
  "targets",
  "nsis",
  "NsisTarget.js"
);

const ORIGINAL = `        else {
            const wineVm = new WineVm_1.WineVmManager((_a = packager.config.toolsets) === null || _a === void 0 ? void 0 : _a.wine);
            await wineVm.exec(installerPath, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });
        }`;

const PATCHED = `        else {
            // [WW-patch] Linux 无 wine：与 macOS Catalina 相同的静态提取方案
            await nsisUtil_1.UninstallerReader.exec(installerPath, uninstallerPath);
        }`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`[eb-patch] 未找到 ${path.relative(ROOT, TARGET)}（请先在 desktop/ 安装依赖）`);
    process.exit(1);
  }
  const src = fs.readFileSync(TARGET, "utf8");
  if (src.includes("[WW-patch]")) {
    console.log("[eb-patch] 已打过补丁，跳过");
    return;
  }
  if (!src.includes(ORIGINAL)) {
    console.error(
      "[eb-patch] 目标代码块未找到（electron-builder 版本可能已变化），请人工核对 NsisTarget.js 的 wine 调用"
    );
    process.exit(1);
  }
  fs.writeFileSync(TARGET, src.replace(ORIGINAL, PATCHED));
  console.log("[eb-patch] 已修补：Linux 构建改为 UninstallerReader 静态提取卸载程序（无需 wine）✔");
}

main();
