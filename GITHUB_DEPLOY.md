# 壁纸工坊 · GitHub 托管手册

本仓库（`xiaobaiba999/bizhi`）用两条分支承载两类内容：

| 分支 | 内容 | 更新脚本 |
|---|---|---|
| `main` | 网页静态版（GitHub Pages 站点） | `scripts/build-gh-pages.mjs` + `scripts/deploy-to-github.mjs` |
| `source` | 完整源码备份（开发快照） | `scripts/push-source-to-github.mjs` |

安装包（~170MB）超仓库 blob 单文件 100MB 上限，托管在 **Release 附件**（上限 2GB，自带 CDN 直链）。

## 为什么走 REST API 而不是 git push

本沙箱网络策略只放行 `api.github.com`（以及 `uploads.github.com`），`github.com` 的
git-receive-pack 通道（`git push`）会被挂起阻断。因此全部改走 Git Data API：
逐文件建 blob → 建整棵 tree（不带 base_tree = 镜像替换）→ 建 commit → 推分支。

## 发布新版本完整流程（三步）

```bash
# 0. 前置：bun run desktop:win 产出 release/壁纸工坊-Setup-<版本>.exe
#    （token 三种给法：命令行参数 / env GITHUB_TOKEN / ~/.bizhi-token 文件）

# ① 网页静态版 → main 分支（GitHub Pages）
node scripts/build-gh-pages.mjs /bizhi
node scripts/deploy-to-github.mjs <token>

# ② 完整源码 → source 分支
node scripts/push-source-to-github.mjs <token>

# ③ 安装包 → Release 附件（tag v<版本>，附件名 ASCII）
node scripts/upload-release-to-github.mjs <token>
```

站点地址：`https://xiaobaiba999.github.io/bizhi/`

网页版下载按钮指向 Release 附件直链（`src/lib/version.ts` 的 `RELEASE_SETUP_URL`），
上传后自动与 Release 保持一致。

## token 权限要求（二选一）

- Fine-grained（推荐）：只选 `xiaobaiba999/bizhi` 一个仓库，
  权限 Contents: Read and write + Pages: Read and write
- Classic：勾 `repo`（`public_repo` 亦可推送，但 Pages 开启可能需手动）

用完到 GitHub → Settings → Developer settings 撤销。

## 常见问题

- **Pages 打不开**：仓库 Settings → Pages → Deploy from a branch → `main` / (root)，
  首次构建约 1-2 分钟。
- **Release 上传慢/失败**：170MB 走 `uploads.github.com`，脚本内置 3 次整档重试；
  持续失败多为本地带宽，重跑即可（脚本会先清理同名旧附件再传，不重复）。
- **沙箱内 git remote 推送**：不可用（通道阻断），永远用上面三个脚本。
