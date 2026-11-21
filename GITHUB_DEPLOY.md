# 壁纸工坊 · GitHub 托管手册

本仓库（`xiaobaiba999/bizhi`）用两条分支承载两类内容：

| 分支 | 内容 | 更新脚本 |
|---|---|---|
| `main` | 网页静态版（GitHub Pages 站点） | `scripts/build-gh-pages.mjs` + `scripts/deploy-to-github.mjs` |
| `source` | 完整源码备份（开发快照） | `scripts/push-source-to-github.mjs` |

Release 附件托管网页版离线压缩包（`WallpaperWorkshop-Web-v<版本>.zip`）与
Windows 桌面安装包（`WallpaperWorkshop-Setup-v<版本>.exe`，v1.4.7 起）。

## 为什么走 REST API 而不是 git push

本沙箱网络策略只放行 `api.github.com`（以及 `uploads.github.com`），`github.com` 的
git-receive-pack 通道（`git push`）会被挂起阻断。因此全部改走 Git Data API：
逐文件建 blob → 建整棵 tree（不带 base_tree = 镜像替换）→ 建 commit → 推分支。

## 发布新版本完整流程（五步）

```bash
# ① 构建静态站（basePath 必须是 /bizhi）：
#    产出 github-pages-dist/ 与 release/WallpaperWorkshop-Web-v<版本>.zip
node scripts/build-gh-pages.mjs /bizhi

# ② 构建 Windows 桌面安装包（渲染层 + electron-builder NSIS）：
#    产出 release/desktop/WallpaperWorkshop-Setup-v<版本>.exe
node scripts/build-desktop.mjs

# ③ 网页静态版 → main 分支（GitHub Pages）
node scripts/deploy-to-github.mjs <token>

# ④ 完整源码 → source 分支（含 desktop/ 桌面版源码）
node scripts/push-source-to-github.mjs <token>

# ⑤ Release：建 v<版本> tag + 上传 exe / zip 双附件 + 写发布说明
node scripts/upload-release-desktop.mjs <token>
```

（token 三种给法：命令行参数 / env `GITHUB_TOKEN` / `~/.bizhi-token` 文件）

站点地址：`https://xiaobaiba999.github.io/bizhi/`

## token 权限要求（二选一）

- Fine-grained（推荐）：只选 `xiaobaiba999/bizhi` 一个仓库，
  权限 Contents: Read and write + Pages: Read and write
- Classic：勾 `repo`（`public_repo` 亦可推送，但 Pages 开启可能需手动）

用完到 GitHub → Settings → Developer settings 撤销。

## 常见问题

- **Pages 打不开**：仓库 Settings → Pages → Deploy from a branch → `main` / (root)，
  首次构建约 1-2 分钟。
- **附件上传失败**：脚本内置 3 次整档重试；持续失败多为本地带宽，重跑即可
  （脚本会先清理同名旧附件再传，不重复）。
- **沙箱内 git remote 推送**：不可用（通道阻断），永远用上面四个脚本。
- **静态版与服务器版差异**：静态版无 `/api`（浏览器直连源站 + localStorage
  记录）；服务器版有图片代理与 SQLite 记录。功能逻辑共用同一实现
  （见 `src/lib/workshop-source.ts`）。

## Windows 桌面版构建要点（desktop/）

- **一条龙**：`node scripts/build-desktop.mjs`（render 渲染层 → dist NSIS 打包；
  也可 `render` / `dist` 分步）
- **渲染层**：同一套 Next.js 静态导出，`NEXT_PUBLIC_DESKTOP=1` 且无 basePath，
  构建到独立 distDir（`.desktop-render-build`，不影响 dev 的 `.next`）
- **主进程**：`desktop/main.js`（app:// 自定义协议本地加载、下载接管自动保存、
  系统通知、窗口状态记忆、外链走系统浏览器）
- **无 wine 构建**：Linux 上 electron-builder 默认用 wine 运行安装器提取
  卸载程序；本仓库的 `scripts/patch-electron-builder-linux.mjs`（dist 阶段自动
  调用）把它替换为 `UninstallerReader` 纯 JS 静态提取，免 wine 完整构建
- **镜像**：沙箱内 Electron / NSIS 工具链二进制走 npmmirror（脚本自动设置
  `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`）
- **npm 11 依赖脚本限制**：安装后若提示 install-scripts 未放行，手动执行
  `cd desktop/node_modules/electron && node install.js` 下载二进制
- **本地验证**：`cd desktop && WW_SMOKE=1 electron .`（xvfb 无头也可），
  输出 JSON 报告 + 截图，退出码 0 = 页面与壁纸图片正常
