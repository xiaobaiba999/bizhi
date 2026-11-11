import type { NextConfig } from "next";

/**
 * 三种构建形态（由环境变量切换，互不干扰）：
 * - 默认（dev / 沙箱）：常规 dev 服务器，含 /api/* 路由
 * - NEXT_OUTPUT_STANDALONE=1：桌面版（Electron 内嵌 standalone 服务器）
 * - NEXT_OUTPUT_EXPORT=1：纯静态导出（GitHub Pages 等静态托管，无 API；
 *   构建时由 scripts/build-gh-pages.mjs 临时移走 src/app/api 与 src/instrumentation.ts）
 *   GH_BASE_PATH：静态托管子路径（如项目页 /repo-name），用户根仓库
 *   （username.github.io）留空即可
 */
const isDesktopBuild = process.env.NEXT_OUTPUT_STANDALONE === "1";
const isExportBuild = process.env.NEXT_OUTPUT_EXPORT === "1";

const nextConfig: NextConfig = {
  // Cache Components / PPR 依赖服务器运行时，静态导出下关闭
  ...(isExportBuild ? {} : { cacheComponents: true, partialPrefetching: true }),
  // dev 跨域保护默认不含 127.0.0.1（会被静默拦截 PPR resume 请求导致水合挂起）；
  // 预览网关域名一并放行，避免开发字体等资源被拦
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "preview-chat-32cc72a7-069a-47a8-ad85-fc25d9ccc148.space.zhipuaidemo.cn",
  ],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  ...(isExportBuild
    ? {
        output: "export" as const,
        images: { unoptimized: true },
        basePath: process.env.GH_BASE_PATH || undefined,
        // 子路径与静态模式标记注入客户端包（图片直连 / SW 注册 / 模式判定等用）
        env: {
          NEXT_PUBLIC_BASE_PATH: process.env.GH_BASE_PATH || "",
          NEXT_PUBLIC_STATIC_EXPORT: "1",
        },
      }
    : {}),
  ...(isDesktopBuild
    ? {
        output: "standalone" as const,
        // Prisma 原生引擎（.node 二进制）需显式纳入 standalone 追踪
        outputFileTracingIncludes: {
          "/**": ["./node_modules/.prisma/client/**"],
        },
      }
    : {}),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
