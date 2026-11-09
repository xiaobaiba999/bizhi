import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // shadcn/ui 生成组件（含 radix any 类型）
    "src/components/ui/**",
    // 非应用源码目录
    "skills/**",
    "scripts/**",
    "download/**",
    "upload/**",
    // 桌面版（Electron）构建产物与源码（CommonJS，不经 Next 编译）
    ".next-desktop/**",
    "release/**",
    "desktop/**",
    "public/desktop/**",
    "tool-results/**",
    // GitHub Pages 静态导出产物与构建暂存目录
    "github-pages-dist/**",
    ".gh-pages-build/**",
    ".api-stash/**",
    ".desktop-stash/**",
  ]),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
