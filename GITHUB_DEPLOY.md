# 壁纸工坊 · GitHub Pages 部署指南（仓库 xiaobaiba999/bizhi）

目标仓库：**https://github.com/xiaobaiba999/bizhi**
部署成功后的站点地址：**https://xiaobaiba999.github.io/bizhi/**

静态版在浏览器内直连哲风壁纸源站抓取数据（源站 CORS 全开），图片直连 CDN 展示，
下载记录保存在浏览器 localStorage（同一浏览器 / PWA 安装内永久保留，
刷新、重装应用都不丢，可在界面上「隐藏已下载」屏蔽）。

---

## 一、一键部署（推荐）：给助手一个 token

本沙箱网络只放行 `api.github.com`（REST API），`git push` 通道被阻断，
因此部署走 **GitHub REST API**（`scripts/deploy-to-github.mjs`：
逐文件建 blob → 整树提交 → 推 main 分支 → 自动开启 Pages）。

你只需要提供一个 token（二选一，推荐前者）：

1. 打开 github.com → 右上角头像 → **Settings** → 左栏最底 **Developer settings**
2. **Fine-grained tokens**（推荐）→ Generate new token
   - Repository access → **Only select repositories** → 选 `xiaobaiba999/bizhi`
   - Permissions → **Contents: Read and write**、**Pages: Read and write**
   - 生成后复制 `github_pat_` 开头的字符串发给助手即可
3. 或 **Tokens (classic)** → Generate new token → 勾选 `repo` 一项即可

助手拿到 token 后执行：

```bash
node scripts/build-gh-pages.mjs /bizhi     # 构建静态站（子路径必须与仓库名一致）
node scripts/deploy-to-github.mjs <token>  # 一键推送到仓库并开启 Pages
```

约 1 分钟后访问 **https://xiaobaiba999.github.io/bizhi/** 即可。
token 用完可随时到 GitHub → Settings → Developer settings 里删除（Revoke）。

## 二、手动部署（不想用 token 时）

1. 本地构建：`node scripts/build-gh-pages.mjs /bizhi`
2. 打开仓库页 https://github.com/xiaobaiba999/bizhi → 「**Add file → Upload files**」
3. 把 `github-pages-dist/` 文件夹里的**全部内容**（不是文件夹本身）拖进上传区
   （86 个文件，低于 GitHub 网页单次 100 个上限）
4. **Commit changes**，然后仓库 **Settings → Pages → Deploy from a branch → main / (root)**
5. 等 1-2 分钟，访问 **https://xiaobaiba999.github.io/bizhi/**

也可以直接把 `download/壁纸工坊-网页版-GitHubPages-v1.3.2.zip` 解压后上传（内容一致）。

## 三、部署后验证清单

- 打开站点，顶部出现「电脑壁纸 / 手机壁纸」切换，壁纸正常出图
- 滚动列表可持续加载（电脑壁纸约 2 万张、手机壁纸约 1 万张，一路滚到底）
- 下载一张壁纸：浏览器另存为 JPG
- 「隐藏已下载（1）」计数出现，**刷新页面后记录仍在**（localStorage 永久保存）
- 点浏览器地址栏「安装」图标可把站点装成独立窗口应用（PWA）
- 手机上用 Chrome / Safari 打开同样可用，可「添加到主屏幕」

## 四、静态版与桌面版的差异

| 能力 | 静态版（GitHub Pages） | 桌面版 exe |
|------|----------------------|-----------|
| 壁纸浏览 / 预览 / 下载 | ✅ | ✅ |
| 下载记录永久保留 | ✅ 浏览器 localStorage | ✅ 应用数据库 |
| 下载分辨率 | CDN 直链（约 1-2K 预览级） | 配置令牌后与官网一致（最高 7K） |
| 哲风令牌登录 | ❌（需服务端人机验证） | ✅ |
| 数据来源 | 浏览器直连源站 | 本地内嵌服务器抓取 |

两边的下载记录相互独立（不同浏览器环境），互不影响。

## 五、常见问题

**Q：部署后页面空白 / 404？**
确认仓库 Settings → Pages 已开启且 Source 为 main / (root)；本站挂在 `/bizhi/`
子路径下（仓库名即路径），直接访问 `https://xiaobaiba999.github.io/` 根路径是 404 属正常。

**Q：图片全部裂图？**
源站 CDN 偶发波动，页面已内置自动重试；持续异常请稍后再试。

**Q：GitHub 上传提示文件太大？**
本项目静态产物约 0.9MB，远低于限制；Windows 安装包（约 175MB）**不要**传进仓库
（超 GitHub 单文件 100MB 上限）——如需在 GitHub 分发 exe，请使用仓库 **Releases** 页面
的附件上传（单附件上限 2GB）。

**Q：想改到别的仓库 / 子路径？**
重新构建时传相同子路径参数即可：`node scripts/build-gh-pages.mjs /你的子路径`，
并同步修改 `scripts/deploy-to-github.mjs` 顶部的 `OWNER / REPO / BASE_PATH` 常量。
