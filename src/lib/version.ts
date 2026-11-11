import pkg from "../../package.json"

/** 应用版本号（单一来源：package.json，避免页脚/安装弹窗等处硬编码过期） */
export const APP_VERSION: string = pkg.version

/** 桌面安装包文件名（与 electron-builder.yml 的 artifactName 保持一致） */
export const SETUP_EXE_NAME = `壁纸工坊-Setup-${APP_VERSION}.exe`

/**
 * 静态托管（GitHub Pages）版的安装包分发走仓库 Release 附件
 *（Release 附件名仅支持 ASCII，故与本地 exe 文件名不同）。
 * 服务器模式仍走同源 /desktop/ 直链。
 */
export const GITHUB_REPO = "xiaobaiba999/bizhi"
export const RELEASE_SETUP_URL = `https://github.com/${GITHUB_REPO}/releases/download/v${APP_VERSION}/WallpaperWorkshop-Setup-v${APP_VERSION}.exe`
