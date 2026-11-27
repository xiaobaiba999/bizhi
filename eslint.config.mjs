import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript rules
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",
    
    // React rules
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/purity": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",
    
    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",
    
    // General JavaScript rules
    "prefer-const": "off",
    "no-unused-vars": "off",
    "no-console": "off",
    "no-debugger": "off",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off",
    "no-unreachable": "off",
    "no-useless-escape": "off",
  },
}, {
  ignores: [
    "node_modules/**",
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "examples/**",
    "skills",
    // 构建产物与本地数据（GitHub Pages 导出 / Release zip / 工具产物）
    "github-pages-dist/**",
    "release/**",
    ".gh-pages-build/**",
    ".api-stash/**",
    "tool-results/**",
    "db/**",
    "download/**",
    "upload/**",
    "mini-services/**",
    ".zscripts/**",
    // 桌面版（Electron）：主进程 / preload 为 CommonJS 脚本不走 Next 规则，
    // renderer/ 为构建产物、node_modules 为本地依赖
    "desktop/renderer/**",
    "desktop/node_modules/**",
    "desktop/main.js",
    "desktop/preload.js",
    "desktop/zf-login.js",
    "desktop/zf-certify.js",
    "desktop/zf-meta.js",
    "desktop/image-quality.js",
    "desktop/original-download.js",
    "desktop/history-db.js",
    ".desktop-render-build/**",
  ]
}];

export default eslintConfig;
