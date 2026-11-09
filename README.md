# 壁纸工坊 · 网页版（GitHub Pages 自动部署）

本仓库是「壁纸工坊」的纯静态网页版，由部署脚本自动推送，站点地址：

**https://xiaobaiba999.github.io/bizhi**

## 功能

- **电脑壁纸 / 手机壁纸**两大频道：浏览器直连哲风壁纸源站实时抓取，
  可一路滚动加载源站全部壁纸（电脑约 2 万张、手机约 1 万张）
- **下载**：直连 CDN 取原图 → 统一转存 JPG → 浏览器另存（Chrome / Edge
  可自选保存文件夹）
- **下载记录永久保存**：记录存在浏览器 localStorage，刷新 / 重装应用
  都不丢；点「隐藏已下载」自动屏蔽已下载过的壁纸
- **PWA 安装**：Chrome / Edge 地址栏「安装」即可装成独立窗口应用，
  正常卸载不留残留

## 下载桌面安装版 / 网页版压缩包

见仓库 **[Releases](https://github.com/xiaobaiba999/bizhi/releases)**：

- `WallpaperWorkshop-Setup-v1.3.3.exe`（约 174MB）—— Windows 桌面安装版，
  下载记录永久保存在用户数据目录（卸载重装自动恢复）
- `WallpaperWorkshop-Web-v1.3.3.zip`（约 0.9MB）—— 本静态网页版的离线压缩包

## 仓库结构

- `main` 分支：即本静态站点（`index.html` / `_next/` / `sw.js` 等），
  由项目源码执行 `node scripts/build-gh-pages.mjs /bizhi` 构建产出，
  再通过 GitHub REST API 一键推送（见源码项目 `scripts/deploy-to-github.mjs`）
- `source` 分支：完整项目源码快照（Next.js 16 + Electron + NSIS），
  由 `node scripts/push-source-to-github.mjs` 推送

> 本站以 `/bizhi` 子路径托管构建，请勿改名或移动文件，否则资源路径会失效。
