// 生成壁纸工坊示例壁纸（SVG）
const fs = require("fs");
const path = require("path");

const W = 864, H = 1152;

const themes = [
  { id: 1, emoji: "☕", c1: "#f7e7d3", c2: "#e8b48c", c3: "#c98a5e", label: "Brunch 日记", cat: "美食" },
  { id: 2, emoji: "🥐", c1: "#fff1e0", c2: "#f5c98a", c3: "#d99a4e", label: "可颂与拿铁", cat: "美食" },
  { id: 3, emoji: "🍵", c1: "#e8f0e0", c2: "#bcd9a8", c3: "#8fae7e", label: "抹茶甜品局", cat: "美食" },
  { id: 4, emoji: "🏔", c1: "#e3ecf5", c2: "#b1c9e0", c3: "#7f9fc4", label: "山野治愈系", cat: "风景" },
  { id: 5, emoji: "🌊", c1: "#e0f0f2", c2: "#a8d4dc", c3: "#6fb0be", label: "海边日落", cat: "风景" },
  { id: 6, emoji: "👗", c1: "#f5e6ef", c2: "#e3bcd3", c3: "#c491ae", label: "秋冬穿搭", cat: "穿搭" },
  { id: 7, emoji: "🐕", c1: "#fdf0dd", c2: "#f3cf9a", c3: "#d9a35f", label: "遛狗日常", cat: "宠物" },
  { id: 8, emoji: "🌿", c1: "#eaf3ea", c2: "#c4e0c6", c3: "#93c296", label: "绿植角落", cat: "家居" },
  { id: 9, emoji: "💄", c1: "#fdeaf0", c2: "#f6bfd0", c3: "#e48fa8", label: "护肤分享", cat: "美妆" },
  { id: 10, emoji: "🍜", c1: "#fdeee0", c2: "#f7c9a3", c3: "#e0956a", label: "深夜食堂", cat: "美食" },
  { id: 11, emoji: "📱", c1: "#eceef7", c2: "#c3c8e6", c3: "#979fd1", label: "桌面改造", cat: "好物" },
  { id: 12, emoji: "🍂", c1: "#fbeedd", c2: "#eecf9f", c3: "#d3a465", label: "秋日街头", cat: "城市" },
  { id: 13, emoji: "🌸", c1: "#fde8ef", c2: "#f7c1d4", c3: "#e08bb0", label: "樱花列车", cat: "风景" },
  { id: 14, emoji: "🗻", c1: "#e8f1f6", c2: "#c6d9e6", c3: "#9db8cf", label: "云端雪山", cat: "风景" },
  { id: 15, emoji: "🌌", c1: "#1a1f33", c2: "#2e3d66", c3: "#4a5fa5", label: "极光之夜", cat: "风景", dark: true },
  { id: 16, emoji: "🥤", c1: "#fff3e0", c2: "#ffd9a8", c3: "#f7a85c", label: "夏日汽水", cat: "美食" },
  { id: 17, emoji: "🍓", c1: "#fdeef2", c2: "#f9c6d2", c3: "#ee93a8", label: "草莓蛋糕", cat: "美食" },
  { id: 18, emoji: "⛺", c1: "#232a3d", c2: "#3a4a6b", c3: "#6b7fa8", label: "露营星河", cat: "旅行", dark: true },
  { id: 19, emoji: "👖", c1: "#eef3f7", c2: "#c3d2e0", c3: "#8fa5bd", label: "复古牛仔", cat: "穿搭" },
  { id: 20, emoji: "🛋", c1: "#fbf3e8", c2: "#eed9c0", c3: "#d4b08c", label: "奶油客厅", cat: "家居" },
  { id: 21, emoji: "🧴", c1: "#f6eff8", c2: "#e2d2ea", c3: "#bfa3d1", label: "香水试香", cat: "美妆" },
  { id: 22, emoji: "🐱", c1: "#fdf1e3", c2: "#f5d5ae", c3: "#e0a967", label: "橘猫午睡", cat: "宠物" },
  { id: 23, emoji: "⌨️", c1: "#eceef2", c2: "#cdd2dc", c3: "#a3aab8", label: "机械键盘", cat: "好物" },
  { id: 24, emoji: "🌃", c1: "#1f2430", c2: "#39415c", c3: "#7c5a8f", label: "雨夜霓虹", cat: "城市", dark: true },
];

function svgFor(t) {
  const dark = !!t.dark;
  const labelFill = dark ? "#ffffff" : "#ffffff";
  const badgeText = dark ? "#2a2f45" : t.c3;
  const glowOpacity = dark ? 0.22 : 0.65;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.c1}"/>
      <stop offset="0.55" stop-color="${t.c2}"/>
      <stop offset="1" stop-color="${t.c3}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.35" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${glowOpacity}"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <circle cx="${W * 0.82}" cy="${H * 0.16}" r="150" fill="#ffffff" opacity="0.18"/>
  <circle cx="${W * 0.18}" cy="${H * 0.78}" r="220" fill="#ffffff" opacity="0.10"/>
  <circle cx="${W * 0.9}" cy="${H * 0.66}" r="90" fill="#ffffff" opacity="0.12"/>
  <path d="M0 ${H * 0.86} C ${W * 0.3} ${H * 0.8}, ${W * 0.7} ${H * 0.94}, ${W} ${H * 0.84} L ${W} ${H} L 0 ${H} Z" fill="#ffffff" opacity="0.16"/>
  <path d="M0 ${H * 0.92} C ${W * 0.35} ${H * 0.86}, ${W * 0.65} ${H * 0.98}, ${W} ${H * 0.9} L ${W} ${H} L 0 ${H} Z" fill="#ffffff" opacity="0.22"/>
  <text x="${W / 2}" y="${H / 2 - 20}" font-size="300" text-anchor="middle" dominant-baseline="middle" opacity="0.92">${t.emoji}</text>
  <text x="${W / 2}" y="${H * 0.70}" font-size="56" font-weight="700" text-anchor="middle" fill="${labelFill}" opacity="0.95" font-family="PingFang SC, Microsoft YaHei, sans-serif">${t.label}</text>
  <rect x="${W / 2 - 90}" y="${H * 0.745}" width="180" height="56" rx="28" fill="#ffffff" opacity="0.9"/>
  <text x="${W / 2}" y="${H * 0.745 + 28}" font-size="30" font-weight="600" text-anchor="middle" dominant-baseline="middle" fill="${badgeText}" font-family="PingFang SC, Microsoft YaHei, sans-serif"># ${t.cat}</text>
</svg>`;
}

const outDir = path.join(__dirname, "..", "public", "gallery");
fs.mkdirSync(outDir, { recursive: true });
for (const t of themes) {
  fs.writeFileSync(path.join(outDir, `photo-${t.id}.svg`), svgFor(t));
}
console.log(`Generated ${themes.length} SVGs -> public/gallery`);
