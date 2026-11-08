import pkg from "../../package.json"

/** 应用版本号（单一来源：package.json，避免页脚/安装弹窗等处硬编码过期） */
export const APP_VERSION: string = pkg.version

/** 桌面安装包文件名（与 electron-builder.yml 的 artifactName 保持一致） */
export const SETUP_EXE_NAME = `壁纸工坊-Setup-${APP_VERSION}.exe`
