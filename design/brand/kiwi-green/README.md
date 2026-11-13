# Kiwi Search 绿色标志

2026-11-13。圆润的 K 是主识别，向右伸出的上笔画表现探寻的方向感。主色使用叶绿 `#137738`，与界面亮色主题的 `accent` 对齐。标志已接入首页、结果页、设置页、浏览器标签和扩展管理页。

- `mark.svg`：单条闭合路径的矢量主文件，128 × 128 画布；纯色、透明底，可无损缩放。
- `mark.png`：从矢量主文件导出的透明 PNG。
- `size-check.png`：16、24、32、48px 的亮底和暗底尺寸预览。
- `brand-board.png`：内置 imagegen 生成的品牌展示稿，用于查看图标、字标和反白组合的方向。正式图标的几何与颜色以 `mark.svg` 为准。
- `PROMPTS.md`：视觉探索与绿色修订使用的完整提示词。

保留 SVG 画布内的留白。页面通过 `apps/extension/lib/KiwiLogo.tsx` 直接导入这个主文件：CSS mask 提供轮廓，`currentColor` 提供主题色。首页和结果页配 Kiwi 字标，设置页配 Kiwi Search；图形框 `1.1em`，字图间隔 `0.2em`。装饰图形对读屏隐藏，字标和首页链接名称从共享语言包读取。反白时把路径填充改为白色；深色页面的浅绿色版本对应界面令牌 `oklch(0.79 0.12 150)`，近似 `#7FD091`。不要加描边、阴影、渐变或拉伸比例。

扩展使用的派生文件位于 `apps/extension/public/`：`icon/16.png`、`32.png`、`48.png`、`128.png` 由 manifest 显式引用；`favicon.svg` 根据浏览器亮暗主题切换颜色，两页 HTML 同时配置 32px PNG 回退。修改主 SVG 或主题色后，从仓库根目录运行：

```sh
pnpm --filter @kiwi-search/extension generate:brand
```

脚本 `apps/extension/scripts/gen-brand-icons.mjs` 全程离线，用 ImageMagick 7 从主 SVG 生成透明 PNG，并从 `base.css` 读取亮暗强调色写入 favicon；不复制或重画主轮廓。ImageMagick 不在 PATH 时可通过 `MAGICK_BIN` 指定可执行文件。派生文件随仓库保存，普通构建不需要图像工具。已验证重复生成的字节一致、四种 PNG 的尺寸和透明通道正确、favicon 与主 SVG 路径一致。

2026-11-13 已在用户原 Chromium 验证首页、真实网页结果页和设置页的亮暗六种状态，以及标签 favicon 和扩展管理页图标。构建、类型检查及 42 项文案/i18n 检查通过。检查包含宽屏和约 710 CSS px；未覆盖 320px、200% 缩放、所有模式或 Firefox。激活后立即检查的 606 项本地存储完全相同；后续真实搜索更新了缓存和来源状态，最终配置、配对信息和同步存储保持不变，不能把后一次检查写成全部存储不变。

主题色规范、官方资料依据及亮暗色阶见 [DESIGN.md](../../../DESIGN.md)。完整激活、备份及浏览器验证记录见 [newtab-page.md](../../../docs/internals/newtab-page.md)。[FRONTEND-PLAN.md](../../../docs/FRONTEND-PLAN.md) 的后续六批仍未实施、未验收；本次完成的是品牌接入。
