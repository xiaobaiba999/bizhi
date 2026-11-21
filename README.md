# 壁纸工坊 · 网页版（GitHub Pages 自动部署）

本仓库是「壁纸工坊」的纯静态网页版，由部署脚本自动推送，站点地址：

**https://xiaobaiba999.github.io/bizhi**

## Windows 桌面版（v1.4.7 新增）

除本网页版外，还提供 **Windows 桌面安装版**（Electron，Win10/11 x64）：
见 **[Releases](https://github.com/xiaobaiba999/bizhi/releases/latest)** 下载
`WallpaperWorkshop-Setup-v1.4.7.exe`（约 97MB）—— 向导式安装，
壁纸自动保存到「图片 / WallpaperWorkshop」并弹系统通知，记录独立持久。

## 网页版功能

- **电脑壁纸 / 手机壁纸**两大频道：浏览器直连哲风壁纸源站实时抓取，
  可一路滚动加载源站全部壁纸（电脑约 2 万张、手机约 1 万张）
- **下载**：直连 CDN 取原图 → 浏览器另存（Chrome / Edge 可自选保存文件夹）
- **下载记录永久保存**：记录存在浏览器 localStorage，刷新页面不丢；
  「隐藏已下载」自动屏蔽已下载过的壁纸；屏蔽的永久不再显示
- **v1.4.5 核心修复**：游标深度扫描 —— 下载过几百张后依旧能自动
  越过已下载/已屏蔽内容继续出图，不再「图片经常不显示 / 刷新没用」
- **v1.4.6 优化**：刷新强制回源 + 空轮自动续扫（最多 200 页）；
  死链缩略图回退链秒级兜底

## 下载网页版离线压缩包

见仓库 **[Releases](https://github.com/xiaobaiba999/bizhi/releases)**：

- `WallpaperWorkshop-Web-v1.4.7.zip`（约 0.5MB）—— 本静态网页版的离线压缩包，
  解压后**双击 index.html 即可用**（无需服务器；壁纸加载需联网）

## 仓库结构

- `main` 分支：即本静态站点（`index.html` / `_next/` 等），
  由项目源码执行 `node scripts/build-gh-pages.mjs /bizhi` 构建产出，
  再通过 GitHub REST API 一键推送（见源码项目 `scripts/deploy-to-github.mjs`）
- `source` 分支：完整项目源码快照（Next.js 16 + Prisma + Tailwind 4 +
  Electron 桌面版），由 `node scripts/push-source-to-github.mjs` 推送

> 本站以 `/bizhi` 子路径托管构建，请勿改名或移动文件，否则资源路径会失效。
