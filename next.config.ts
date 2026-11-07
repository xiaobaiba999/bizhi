import type { NextConfig } from "next";

/**
 * 桌面版打包说明：
 * - NEXT_OUTPUT_STANDALONE=1 时以 standalone 产物输出（Electron 内嵌运行）
 * - NEXT_DIST_DIR 指定独立构建目录（默认 .next-desktop），避免与 dev:3000 的 .next 冲突
 */
const isDesktopBuild = process.env.NEXT_OUTPUT_STANDALONE === "1";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // dev 跨域保护默认不含 127.0.0.1（会被静默拦截 PPR resume 请求导致水合挂起）；
  // 预览网关域名一并放行，避免开发字体等资源被拦
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "preview-chat-32cc72a7-069a-47a8-ad85-fc25d9ccc148.space.zhipuaidemo.cn",
  ],
  distDir: process.env.NEXT_DIST_DIR || ".next",
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
