import type { MetadataRoute } from "next"

/** 静态导出构建要求：metadata 路由标记为纯静态（服务器模式行为不变） */
export const dynamic = "force-static"

/**
 * PWA 应用清单（/manifest.webmanifest）：
 * 安装后如同桌面软件：独立窗口、桌面/开始菜单图标、任务栏常驻；
 * 卸载走系统应用管理，自动清除本地缓存与存储，无残留。
 * 子路径托管（GitHub Pages /bizhi）时由构建脚本改写 start_url / scope / 图标。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "壁纸工坊",
    short_name: "壁纸工坊",
    description:
      "哲风壁纸高清壁纸实时获取：分类浏览、大图预览、单张/批量下载，已下载自动隐藏。可安装到桌面独立运行。",
    lang: "zh-CN",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#e11d48",
    categories: ["personalization", "utilities", "photo"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}
