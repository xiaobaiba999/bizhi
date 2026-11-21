import type { NextConfig } from "next";

/**
 * 两种构建形态（由环境变量切换，互不干扰）：
 * - 默认（dev / 沙箱）：常规 dev 服务器（output: standalone 仅影响正式构建），含 /api/* 路由
 * - NEXT_OUTPUT_EXPORT=1：纯静态导出（GitHub Pages 等静态托管，无 API；
 *   构建时由 scripts/build-gh-pages.mjs 临时移走 src/app/api）
 *   GH_BASE_PATH：静态托管子路径（本项目为 /bizhi）
 *
 * 静态版运行时行为（见 src/lib/workshop-source.ts）：
 * - 浏览器直连哲风源站抓取（源站 CORS 全开）解析壁纸列表
 * - 图片直连 CDN（页面全局 no-referrer 绕过防盗链）
 * - 下载：CDN 取图 blob → 浏览器另存；记录存 localStorage（永久、可屏蔽）
 */
const isExportBuild = process.env.NEXT_OUTPUT_EXPORT === "1";

const nextConfig: NextConfig = {
  // 独立 distDir：静态导出构建不打扰 dev 服务器正在使用的 .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  ...(isExportBuild
    ? {
        output: "export" as const,
        images: { unoptimized: true },
        basePath: process.env.GH_BASE_PATH || undefined,
        // 子路径与静态模式标记注入客户端包（模式判定 / 图片直连等用）
        env: {
          NEXT_PUBLIC_BASE_PATH: process.env.GH_BASE_PATH || "",
          NEXT_PUBLIC_STATIC_EXPORT: "1",
        },
      }
    : {
        output: "standalone" as const,
      }),
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
