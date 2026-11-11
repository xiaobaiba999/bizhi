# 壁纸工坊

哲风壁纸（haowallpaper.com）实时获取与原图下载工具 —— 网页版 + Windows 桌面安装版。

![tech](https://img.shields.io/badge/Next.js-16-black) ![ts](https://img.shields.io/badge/TypeScript-5-blue) ![electron](https://img.shields.io/badge/Electron-45-9feaf9) ![prisma](https://img.shields.io/badge/Prisma-SQLite-2d3748)

## 功能

- **壁纸实时获取**：直连哲风壁纸源站，电脑壁纸 / 手机壁纸两大分类，无限滚动
- **下载原图**：已配置令牌时与官网分辨率、文件大小完全一致（走官网 `getCompleteUrl`）
- **屏蔽永久保留**：屏蔽过的壁纸永久不再显示 —— 记录存于本机数据库，升级版本、重装系统应用都不丢
- **下载过的自动隐藏**：可选开关，清空记录后恢复显示
- **批量下载**：多选最多 18 张一键批量保存
- **自选保存位置**：
  - 桌面版：系统磁盘文件夹选择器，永久记住（settings.json）
  - 网页版：Chrome / Edge 目录选择（File System Access），句柄存 IndexedDB，跨会话自动恢复
- **扫码 / 令牌登录**：哲风账号扫码或粘贴令牌，高清原图下载鉴权

## Windows 桌面版

安装包见本仓库 Release / `download/` 目录（`壁纸工坊-Setup-1.x.x.exe`，约 167MB，NSIS 向导式安装）：

- 向导式安装、独立窗口运行、桌面与开始菜单快捷方式
- 壁纸自动存入「下载\壁纸工坊」，可任意自选保存位置
- **升级数据保护（v1.4.2）**：
  - 升级安装全程「护送」用户数据目录（`%APPDATA%\壁纸工坊`）—— 先转移到安全位置，旧版卸载完成后再原样放回，无论旧卸载器做什么都删不到数据
  - 数据库永不因缺表/缺列重建：有效 SQLite 文件一律保留，缺的表/列由服务端启动时自动修补（`src/instrumentation.ts`），已有记录一条不丢
  - 卸载向导默认保留用户数据，仅主动勾选「同时删除应用数据」才清理

## 开发

```bash
bun install
bun run db:push          # 初始化 SQLite（db/custom.db）
bun run dev              # 网页版 http://localhost:3000

# 桌面版打包（需在项目根执行）
node scripts/build-desktop.mjs --win     # 生产构建 + Windows NSIS 安装包
node scripts/build-desktop.mjs --linux   # Linux 解包版（本地冒烟测试）
```

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Next.js 16（App Router）· React 19 · Tailwind CSS 4 · shadcn/ui · Zustand · Framer Motion |
| 后端 | Next.js API Routes · Prisma ORM（SQLite）· 哲风壁纸源站抓取与鉴权 |
| 桌面 | Electron 45（内嵌 Next standalone 服务器）· electron-builder + NSIS |

## 目录结构

```
src/app/api/wallpapers/    # 壁纸列表 / 图片代理 / 下载 / 屏蔽 API
src/components/workshop/   # 壁纸工坊主界面
src/lib/zhefeng.ts         # 源站抓取与解析
src/lib/web-download-dir.ts# 网页版自选目录持久化（IndexedDB）
src/instrumentation.ts     # 服务端启动：数据库缺表/缺列自动修补
desktop/                   # Electron 主进程 / preload
build/installer.nsh        # NSIS 定制：升级数据护送 + 卸载勾选页
scripts/build-desktop.mjs  # 桌面打包流水线
```

## 声明

壁纸内容来自哲风壁纸（haowallpaper.com），版权归原作者所有，本项目仅供个人学习与使用。
