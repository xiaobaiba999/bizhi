# 壁纸工坊（v1.4.7 桌面版）

哲风壁纸实时获取与原图下载工具。Next.js 16 + TypeScript + Tailwind CSS 4 +
shadcn/ui + Prisma（SQLite）构建，同一套代码支持三种运行形态：

| 形态 | 说明 | 数据存储 |
|---|---|---|
| **服务器版**（默认 dev / `next start`） | 服务端抓取源站 + 图片代理（绕 CDN 防盗链）+ 原图下载代理 | SQLite（Prisma） |
| **静态网页版**（GitHub Pages） | 浏览器直连哲风源站抓取（源站 CORS 全开），图片直连 CDN（`no-referrer` 绕防盗链） | localStorage |
| **Windows 桌面版**（Electron，v1.4.7 新增） | 静态版同源渲染层 + `app://` 协议本地加载；下载接管自动保存「图片/WallpaperWorkshop」+ 系统通知 | 应用本地（localStorage，独立于浏览器） |

在线地址：**https://xiaobaiba999.github.io/bizhi/**
桌面安装包：**[Releases](https://github.com/xiaobaiba999/bizhi/releases)**
（`WallpaperWorkshop-Setup-v1.4.7.exe`，Windows 10/11 x64）

## 功能

- **电脑壁纸 / 手机壁纸**两大频道，游标深度扫描无限滚动
  （4 页一组并行扫描、单轮最多 40 页、空轮自动续扫 —— 下载过几百张后
  依旧能自动越过已下载 / 已屏蔽内容继续出图）
- **单张 / 批量下载**（最多 18 张）：服务器版走代理下载落库；
  静态版直连 CDN 取 blob 另存
- **下载过的自动隐藏**（可临时关闭查看 / 一键清空记录）
- **屏蔽**：不喜欢的壁纸永久不再显示（可清空恢复）
- **大图预览**、分辨率徽标、标签展示
- **v1.4.7**：新增 Windows 桌面安装版（Electron 封装，见下文）
- **v1.4.6**：刷新强制回源（绕过页缓存）+ 空轮自动续扫至 200 页；
  图片代理对 CDN 永久 404 缩略图负缓存 5 分钟不重试，回退链秒级兜底

## 开发

```bash
bun install          # 安装依赖（含 prisma generate）
bun run db:push      # 初始化 SQLite（db/custom.db）
bun run dev          # http://localhost:3000
bun run lint         # ESLint
```

## 部署（GitHub Pages + 源码备份 + Release）

```bash
node scripts/build-gh-pages.mjs /bizhi     # ① 构建静态站 → github-pages-dist/ + release/web.zip
node scripts/deploy-to-github.mjs <token>  # ② 推 main 分支（GitHub Pages）
node scripts/push-source-to-github.mjs <token> # ③ 推 source 分支（源码快照，含 desktop/）
node scripts/upload-release-desktop.mjs <token> # ④ 建 v1.4.7 Release + 上传 exe / zip 附件
```

## Windows 桌面版（Electron）

```bash
node scripts/build-desktop.mjs        # 一条龙：渲染层构建 + NSIS 安装包
# 或分步：
node scripts/build-desktop.mjs render  # 只构建渲染层 → desktop/renderer/
node scripts/build-desktop.mjs dist    # 只打包 → release/desktop/WallpaperWorkshop-Setup-v<版本>.exe
node scripts/make-desktop-icon.mjs     # 单独重生成图标（desktop/build/icon.ico / icon.png）
```

要点：
- 渲染层 = 同一套 Next.js 静态导出（`NEXT_PUBLIC_DESKTOP=1`，无 basePath）
- 主进程 `desktop/main.js`：`app://` 自定义协议本地加载（origin 稳定，记录持久）、
  下载接管自动保存 + 系统通知、外链走系统浏览器、窗口状态记忆
- Linux/macOS 也可构建 Windows 包：脚本自动打补丁用 `UninstallerReader`
  静态提取卸载程序（免 wine）；Electron / NSIS 工具链走 npmmirror 镜像
- 本地冒烟：`cd desktop && WW_SMOKE=1 electron .`（xvfb 无头亦可，
  输出 JSON 报告 + 截图，退出码 0 = 图片正常加载）

详见 [GITHUB_DEPLOY.md](./GITHUB_DEPLOY.md)（沙箱内 git push 通道被阻断，
全部走 api.github.com REST API）。

## 目录结构

```
src/
  app/
    page.tsx                 # 主页（WorkshopTab）
    api/wallpapers/          # 列表（游标深度扫描）/ 图片代理 / 下载 / 记录
  components/workshop/       # 主界面 / 壁纸图片（回退链+自动重试）/ 已选面板
  lib/
    zhefeng.ts               # 哲风壁纸源站抓取 + 解析 + 深度扫描
    workshop-source.ts       # UI 数据层（服务器 / 静态双模式自动适配）
    download-store.ts        # 静态模式下载记录（localStorage）
    block-store.ts           # 静态模式屏蔽记录（localStorage）
prisma/schema.prisma         # Download / Blocked 两张表
desktop/                     # Electron 桌面版（main.js + package.json + build 图标；
                             #   renderer/ 为构建产物不入库）
scripts/                     # GitHub Pages / 桌面版构建 / 部署 / 源码推送 / Release 上传
```

## 数据来源

壁纸数据实时获取自 [哲风壁纸](https://haowallpaper.com)，仅供个人学习交流，
请勿用于商业用途。
