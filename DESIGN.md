---
name: Kiwi Search
description: 仿 Google 结果页的元搜索新标签页：搜索框就是首页，结果是一列朴素文字，多个引擎都收录的结果才在站点名后淡淡地带几枚引擎小图标；用 Kiwi 自己的靛蓝字标和强调色。
colors:
  bg: "oklch(0.972 0.006 280)"
  surface: "oklch(0.995 0.003 280)"
  surface-2: "oklch(0.948 0.01 280)"
  border: "oklch(0.905 0.012 280)"
  border-ctl: "oklch(0.82 0.015 280)"
  border-strong: "oklch(0.62 0.02 280)"
  fg: "oklch(0.215 0.025 280)"
  fg-2: "oklch(0.35 0.022 280)"
  fg-3: "oklch(0.47 0.02 280)"
  accent: "oklch(0.5 0.23 277)"
  accent-solid: "oklch(0.5 0.23 277)"
  accent-solid-hover: "oklch(0.45 0.225 277)"
  on-accent: "oklch(0.99 0 0)"
  link: "oklch(0.44 0.18 275)"
  link-visited: "oklch(0.44 0.13 325)"
  warn: "oklch(0.49 0.12 65)"
  bad: "oklch(0.51 0.2 27)"
  ok: "oklch(0.48 0.13 155)"
typography:
  display:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif"
    fontSize: "clamp(3rem, 7vw, 4.5rem)"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.03em"
  headline:
    fontSize: "1.25rem"
    fontWeight: 400
    lineHeight: 1.3
  title:
    fontSize: "1.125rem"
    fontWeight: 650
    lineHeight: 1.4
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
  snippet:
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.58
  label:
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
rounded:
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  full: "999px"
spacing:
  pad: "1.5rem"
  gap: "1.5rem"
  brand-w: "5.5rem"
  col-w: "42rem"
  result-gap: "1.6rem"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    height: "2.25rem"
    padding: "0 0.875rem"
  button-hover:
    backgroundColor: "{colors.surface-2}"
  button-primary:
    backgroundColor: "{colors.accent-solid}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    height: "2.25rem"
    padding: "0 0.875rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-solid-hover}"
  search-box:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.full}"
    height: "2.875rem"
    padding: "0 0.375rem 0 1rem"
  tab:
    textColor: "{colors.fg-3}"
    padding: "0.7rem 0.875rem"
  tab-current:
    textColor: "{colors.accent}"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg-2}"
    rounded: "{rounded.full}"
    height: "1.875rem"
    padding: "0 0.8rem"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    height: "2.25rem"
    padding: "0.4rem 0.65rem"
  result-title:
    textColor: "{colors.link}"
    typography: "{typography.headline}"
  result-snippet:
    textColor: "{colors.fg-2}"
    typography: "{typography.snippet}"
---

# Design System: Kiwi Search

## Overview

Kiwi Search 的界面照着 Google 结果页来做：搜索框就是首页，结果是紧贴搜索框左边缘的一列朴素文字。每条结果都是页面底上的纯文字行，没有卡片、分数条和来源标签；唯一成块的是结果上方的 AI 概览。用户要的是结果本身，所以结果由哪几个搜索引擎拼出来平时不提：只有被两个及以上引擎同时收录的结果，才在站点名后带几枚小图标，让融合搜索的价值看得见又不抢眼（见“引擎小图标”）。另一处例外是遇到人机验证时的一行提示，因为那需要用户亲自动手。

Kiwi 自己的辨识度只靠两样东西：靛蓝（色相 277°）的字标和强调色，以及朝同一色相轻微染色的中性色。其余一律克制：系统字体、1px 发丝线、0.15s 的颜色过渡。亮色和暗色是两套分别调过的色板，跟随系统 `prefers-color-scheme`，不是互相反色。

设置页是工具型界面：吸顶保存栏、左侧分区导航、来源用表格。它和新标签页共用同一套令牌、按钮和图标，但密度更高。

数值的唯一来源是代码：令牌在 `apps/extension/lib/base.css`，布局在 `entrypoints/newtab/style.css` 和 `entrypoints/options/style.css`，图标在 `lib/icons.tsx`。改了界面要同步更新这份文档。

**Key Characteristics:**
- 单列结果，列宽 42rem，左边缘与搜索框对齐；首页只有字标、搜索框、模式标签和设置图标。
- 层次靠明度差和发丝线，不靠阴影；整个系统只有一个阴影令牌。
- 唯一的强调色是靛蓝；琥珀和红只表示状态。
- 结果页没有排名、分数、徽章；引擎只以“引擎小图标”的形式出现，且只在多个引擎都收录时。
- 亮暗两套主题都过 WCAG AA：文字 ≥4.5:1，输入框边框 ≥3:1。
- 只用系统字体，不加载网络字体。

## Colors

靛蓝是唯一的品牌色，中性色都朝约 280° 的色相轻微染色，灰不会发死。frontmatter 里是亮色主题的值，暗色主题的值见本节末尾。

### Primary
- **Kiwi 靛蓝**（`accent`）：字标、当前标签、搜索按钮、焦点环、AI 概览标题和引用角标。用在文字、描边和指示条上。
- **靛蓝实心**（`accent-solid`、`accent-solid-hover`，其上的文字用 `on-accent`）：实心主要按钮和勾选框。亮色下和 `accent` 同值；暗色下 `accent` 调亮并降低色度来做文字，`accent-solid` 调暗来托住白字，两种用法都过 AA。

### Neutral
- **页面底**（`bg`）：整页背景。
- **纸面**（`surface`）：搜索框、输入框、按钮、芯片、面板的底，比页面底略亮。
- **雾面**（`surface-2`）：悬停底、代码块、标签、骨架屏、图片占位。
- **发丝线**（`border`）：分隔线和面板边框。
- **控件边**（`border-ctl`）：按钮、搜索框、芯片的轮廓，仅作装饰，不负责让用户认出输入框。
- **输入边**（`border-strong`）：设置页输入框的边，对背景 ≥3:1。
- **正文、次要、辅助**（`fg`、`fg-2`、`fg-3`）：标题与站点名 / 摘要与说明 / 面包屑、状态行、占位符。`fg-3` 也满足 4.5:1，可以当文字用。

### Semantic
- **链接蓝**（`link`）和**已访问紫**（`link-visited`）：结果标题。搜索页必须让人看出哪些结果点过。
- **琥珀**（`warn`）：待人机验证的提示、被隐藏结果的原因、“未配置”标签。
- **红**（`bad`）：错误提示。
- **绿**（`ok`）：令牌已定义，目前没有任何界面用到。以后做成功态时用它，不要另起一个绿。

### Derived tints
不单独存值，由令牌混合而来，一律用 `color-mix(in oklab, …)`：
- `accent-soft` = 10% 靛蓝混入 `surface`：首页的当前模式标签、按下的芯片、引用角标、与概览引用联动的结果高亮。
- 概览卡片底 = 5% 靛蓝混入 `surface`；`warn-soft` = 12% 琥珀混入 `surface`；`bad-soft` = 8% 红混入 `surface`。
- `accent-ring` = 30% 透明的靛蓝，只用于搜索框聚焦光圈。

### Dark theme
`on-accent` 与亮色相同（`oklch(0.99 0 0)`）。

| 令牌 | 暗色值 |
|---|---|
| `bg` | `oklch(0.175 0.014 280)` |
| `surface` | `oklch(0.215 0.016 280)` |
| `surface-2` | `oklch(0.265 0.018 280)` |
| `border` | `oklch(0.31 0.018 280)` |
| `border-ctl` | `oklch(0.42 0.02 280)` |
| `border-strong` | `oklch(0.56 0.022 280)` |
| `fg` | `oklch(0.945 0.008 280)` |
| `fg-2` | `oklch(0.86 0.01 280)` |
| `fg-3` | `oklch(0.73 0.016 280)` |
| `accent` | `oklch(0.79 0.13 277)` |
| `accent-solid` | `oklch(0.56 0.2 277)` |
| `accent-solid-hover` | `oklch(0.51 0.2 277)` |
| `link` | `oklch(0.8 0.11 275)` |
| `link-visited` | `oklch(0.77 0.09 325)` |
| `warn` | `oklch(0.82 0.13 80)` |
| `bad` | `oklch(0.76 0.16 27)` |
| `ok` | `oklch(0.78 0.15 155)` |

### Named Rules
**唯一强调色规则。** 靛蓝是唯一的品牌色。琥珀和红只表示状态，不拿来装饰。唯一的例外是引擎小图标，它们保留各家自己的颜色（暗色主题下提亮到至少 3:1），因为认出是哪家引擎靠的就是颜色和形状；它们小、淡出、只在多引擎收录时出现。

**令牌规则。** 组件 CSS 里只写 `var(--…)`，不写字面颜色。唯一的例外是视频时长角标的半透明深色底（`oklch(0.2 0.02 280 / 0.88)`），它压在任意缩略图上，两个主题下都必须是深色。新增令牌必须同时写亮暗两套。

**对比度规则。** 文字对背景 ≥4.5:1，用来识别输入框的边 ≥3:1。新增或调整颜色后要实际算一遍，两个主题都算。

## Typography

**字体：** 全部用系统字体栈，不加载网络字体（栈见 frontmatter，末尾是中文回退 PingFang SC、Hiragino Sans GB、Microsoft YaHei、Noto Sans CJK SC、Source Han Sans SC）。等宽字体（`ui-monospace, SFMono-Regular, Menlo, Consolas`）只用于代码。

**气质：** 一族字走到底，层级靠字号、字重和颜色拉开，像 Google 结果页一样安静。整个界面最大最亮的文字是结果标题（20px 链接蓝），其余都往后退。

### Hierarchy
- **Display**（700，`clamp(3rem, 7vw, 4.5rem)`，行高 1，字距 -0.03em）：首页字标“Kiwi”。结果页顶栏的字标是同一样式缩到 1.75rem。
- **Headline**（400，1.25rem，行高 1.3）：结果标题。手机宽度（≤640px）1.125rem；视频结果标题 1.0625rem。
- **Title**（650，1.125rem，行高 1.4）：设置页分区标题；设置页 h1 为 1.5rem/650。空状态标题 1.0625rem/600；AI 概览标题 0.9375rem/600、靛蓝。
- **Body**（400，0.9375rem，行高 1.6）：页面默认字号。AI 概览正文行高 1.75。
- **Snippet**（400，0.875rem，行高 1.58，`fg-2`）：结果摘要，也是按钮、模式标签页和设置页控件的字号。
- **Label**（500，0.8125rem，行高 1.5）：设置页字段标签。状态行、芯片、作者行同样是 13px 但字重 400；面包屑、引用角标、标签用 12px。

### Named Rules
**一族字规则。** 不引入第二个字体族。强调靠字重和颜色，不靠换字体。

**数字规则。** 被引次数、引用角标、视频时长、数字输入框用 `font-variant-numeric: tabular-nums`。

**行长规则。** 结果列宽固定 42rem（图片模式例外），不要为了“填满屏幕”加宽；多出来的右侧空间留给 AI 概览（见 Layout）。摘要和概览正文用 `text-wrap: pretty`，概览里的标题用 `balance`。

## Layout

**新标签页。** 一条单列：顶栏（字标、搜索框、设置图标）→ 模式标签 → 状态行 → 结果。尺寸来自 `.page` 上的变量：`--pad` 1.5rem、`--brand-w` 5.5rem、`--gap` 1.5rem。结果列的左边缘 = `pad + brand-w + gap`（8.5rem），所以搜索框、模式标签和结果的左边缘在同一条竖线上。列宽 `--col-w` 42rem，搜索框最大宽度也是 42rem。结果之间隔 1.6rem；每条结果的高亮底色向左右各出血 0.75rem，文字位置不变。

**AI 概览的位置。** 页面宽度 ≥76rem（左边距 8.5rem + 结果列 42rem + 间距 2rem + 右栏最小 22rem + 右边距 1.5rem）时，概览放在结果列右侧的一栏：宽 22–30rem（有多少空间用多少，最多 30rem），`position: sticky; top: 1rem`，比窗口高时在卡片内部滚动，不再折叠（没有“展开”按钮）。窄于 76rem 时回到第 1 条结果上方，并保持折叠。两种位置是同一个组件、同一份 DOM（概览在 DOM 里排在结果前面），只靠 `.body.with-rail` 的媒体查询切换。没有概览的模式（图片、视频、小红书、X）不占右栏。

**首页。** 字标在搜索框上方居中，整体偏上（顶部留白 `clamp(4rem, 24vh, 11rem)`）；搜索框最大 38rem、高 3.25rem；模式标签变成居中的胶囊；设置图标固定在右上角。

**图片模式。** 取消 42rem 列宽，结果占满宽度：等高行网格，目标行高 120 / 160 / 200px（容器宽 <520 / <900 / 其他），格间距 8px。点击图片后右侧停靠 26rem 的预览面板（sticky），不是弹窗。

**响应式。** ≤1000px：结果列贴左边（不再与搜索框对齐），字标列缩到 4.5rem，图片预览变成贴底抽屉（fixed，最高 82vh，上圆角 1rem）。≤640px：页边距 1rem，搜索框独占一行，视频缩略图缩到 8.5rem。

**设置页。** 最大宽 70rem：吸顶栏（最小高 3.5rem）、左侧 11rem 的分区导航（sticky）、最宽 52rem 的主栏。分区之间 2.5rem 间距加一条发丝线。字段是两列网格（行距 1rem、列距 1.25rem），标签在控件上方。≤900px 导航变成横向滚动条；≤680px 字段变单列，来源表的每一行变成一个堆叠块（名称与状态一行，凭据与权重一行）。

## Elevation & Depth

默认是平的：层次靠 `bg` / `surface` / `surface-2` 的明度差和 1px 发丝线。整个系统只有一个阴影令牌 `--shadow-1`，亮色 `0 1px 2px oklch(0.25 0.03 280 / 0.06), 0 2px 10px oklch(0.25 0.03 280 / 0.06)`，暗色 `0 1px 2px oklch(0 0 0 / 0.4), 0 2px 12px oklch(0 0 0 / 0.25)`。它只用在三处：搜索框（悬停时出现）、图片预览面板（它悬在内容上面）和设置页的确认弹窗（同样悬在内容上面，背后是 50% 的深色遮罩）。

焦点：搜索框是靛蓝边框加 3px `accent-ring` 光圈；其他控件统一 2px 靛蓝轮廓、偏移 2px（`:focus-visible`），设置页输入框偏移 0。文字选中色是 28% 靛蓝，光标色是靛蓝。

### Named Rules
**平面优先规则。** 静止的东西不带阴影。阴影只回应交互（悬停），或表示一块面板悬在内容之上。结果、概览、告警都不用。

## Shapes

圆角四档：胶囊（`999px`）给搜索框、芯片、标签和首页的模式标签；`0.5rem` 给按钮、输入框、代码块；`0.75rem` 给告警、表格容器、结果的高亮底；`1rem` 给大面板（AI 概览、图片预览）。更小的元素用固定值：图片格 8px、视频缩略图 0.6rem、引用角标 6px、时长角标 4px。站点图标是圆形（1.75rem，内边距 4px，1px 发丝线，`surface-2` 底）。结果页的模式标签是下划线形：3px 靛蓝指示条，只有上两个角是圆的。

## Components

### 搜索框（标志性组件）
胶囊，1px `border-ctl` 边，`surface` 底，最小高 2.875rem。左边是放大镜（`fg-3`），右边先是“清除”按钮（输入非空时才出现），再是靛蓝的搜索按钮，都是 2.25rem 的圆形图标按钮，悬停变 `surface-2`。悬停出现 `--shadow-1`；聚焦时边框变靛蓝并加 3px 光圈。页面载入自动聚焦，在页面任何位置按 `/` 也会聚焦并全选。

### 模式标签
“全部 / 图片 / 视频 / 学术”，用 `nav` 加 `aria-current="page"`。结果页里是下划线标签：默认 `fg-3`，悬停 `fg`，当前项靛蓝、600 字重、带指示条；整排底部一条发丝线。首页里是居中的胶囊，当前项 `accent-soft` 底、无指示条。

### 结果
- **网页**：圆形站点图标 + 站点名（14px `fg`）+ 面包屑地址（12px `fg-3`，形如 `example.com › docs › page`，超长省略）；下面是 20px 链接蓝标题（无下划线，悬停加下划线，访问过变紫）；再下面是 14px `fg-2` 摘要，有日期时日期放在摘要最前面（`fg-3`）。
- **论文**：没有站点图标。标题下一行是“作者 · 期刊 · 年份”（13px `fg-3`），然后是 320 字以内的摘要，最后一行是 PDF / DOI / 被引次数（13px，数字等宽）。
- **视频**：左边 16:9 缩略图（10.5rem，右下角深色时长角标），右边是标题（17px）、“平台 · 频道 · 播放量 · 发布时间”和最多两行的描述。缩略图加载失败时留 `surface-2` 底。
- **联动**：鼠标悬停在 AI 概览的引用角标上时，对应结果整行用 `accent-soft` 底高亮。

### 引擎小图标
被 2 个及以上引擎同时返回的结果，在站点名后（论文在 PDF / DOI 那一行末尾，视频和知乎等在署名行末尾）带一排 15px 的引擎图标：最多显示 3 个，不透明度依次 1 / 0.65 / 0.4（从左到右淡出），按各引擎给出的名次排，最靠前的在最左；第 4 个起折叠。鼠标悬停或键盘聚焦这一排时，全部图标向右展开并恢复不透明（0.3s、依次错开 30ms），悬停某个图标出现引擎名；移开后收回。图标文件在 `lib/sourceIcons.ts`（由 `scripts/gen-source-icons.mjs` 从 Simple Icons 生成，没有该图标的引擎用首字母徽标），全部随扩展打包，不联网。读屏文字是“Google、Bing 都收录了这条结果”：只说“收录”，不说“验证”，几个引擎都排在前面不等于内容属实。开启“减少动态效果”时不播动画，状态直接切换。小红书国内站和国际站算同一个平台，不会重复出现。

### 被隐藏的结果
过滤器判为垃圾或不相关的结果不进列表，折叠在列表下面，上方一条发丝线。折叠行是链接色的“已隐藏 N 条结果 · 显示”加箭头；展开后以淡化样式显示（标题用 `fg-2`），每条下面一行 12px 琥珀色的原因。

### AI 概览
在结果上方，`surface` 混 5% 靛蓝做底，1px `border`，1rem 圆角，无阴影。标题是星芒图标加“AI 概览”（15px、靛蓝、600）。正文 15px、行高 1.75，Markdown 样式只作用在 `.md` 内（行内代码、代码块、引用块用雾面底，表格用发丝线）。`[n]` 渲染成引用角标（12px、600、靛蓝字、`accent-soft` 底、6px 圆角，悬停变实心靛蓝），直接链接到来源页。

状态：读取来源时是一行说明加 4 条骨架线；流式生成时标题旁有转圈、文末有闪烁光标；完成后超过约 150px（约 6 行）就折叠，底部渐变遮罩加“展开 / 收起”；失败时是红色告警块加“前往设置”。没配置 LLM 时只显示一行灰字提示，不占卡片。

### 状态行与进度条
标签下面一行 13px `fg-3`：“N 条结果（x 秒）”、“仍在加载更多结果…”、过滤失败的原因。需要人机验证时出现一个琥珀色、带三角图标的下划线按钮“有结果需要先完成人机验证，点此前往验证”，这是页面上唯一要用户动手处理的来源提示。搜索进行中，页面顶部有一条 3px 的靛蓝不定进度条（开启“减少动态效果”时变成静态半透明条）。

### 按钮
- **次要**：`surface` 底、1px `border-ctl`、0.5rem 圆角、最小高 2.25rem、14px/500；悬停 `surface-2`；禁用时 `surface-2` 底、`fg-3` 字。
- **主要**：`accent-solid` 底、`on-accent` 字、无边框；悬停 `accent-solid-hover`。
- **图标按钮**：2.5rem 方形、透明底、`fg-3`；悬停 `surface-2` 和 `fg`。仅有图标的按钮必须有 `aria-label`。
- **切换态**（芯片、LLM 预设）：用 `aria-pressed`，按下时靛蓝边、`accent-soft` 底、靛蓝字。

### 芯片
学术模式的“不限时间 / N 年以来 / 按被引次数排序”。胶囊、高 1.875rem、13px，`surface` 底、`border-ctl` 边、`fg-2` 字。

### 告警与空状态
- **告警**：`bad-soft` 底、1px 边（红色与 `border` 按 35% 混合）、0.75rem 圆角；红色圆形感叹号图标、加粗标题、`fg-2` 说明，右侧是“重试”按钮。
- **空状态**：标题“没有找到相关结果”（1.0625rem/600）、`fg-2` 说明（按模式给出下一步；有来源在等验证时改成“完成验证后，结果会自动补充到这里”）和“打开设置”链接。

### 加载骨架
用雾面色的闪烁条（1.6s）代替居中转圈：网页和视频结果各一套，图片是一排大小不一的方块，概览是 4 条线。小转圈（0.75rem）只用在“正在进行”的标题旁。

### 图片网格与预览
等高行网格，格子 8px 圆角、`surface-2` 占位底、`zoom-in` 光标；选中的格子内描 3px 靛蓝轮廓。预览面板：`surface` 底、1px `border`、1rem 圆角、`--shadow-1`；顶部是上一张 / 下一张 / 关闭三个图标按钮，然后是图片（居中在 `surface-2` 的舞台上，最高 52vh，原图加载失败回退缩略图）、标题（16px/500）、“尺寸 · 授权 · 作者”（13px `fg-3`），以及一个主要按钮“访问 {域名}”和一个次要按钮“查看原图”。键盘：← → 切换，Esc 关闭。

### 设置页控件
- **输入框 / 下拉 / 文本域**：最小高 2.25rem，`surface` 底，1px `border-strong` 边，0.5rem 圆角，14px；聚焦时靛蓝边加 2px 靛蓝轮廓（偏移 0）；禁用和只读是 `surface-2` 底加 `border-ctl` 边。下拉用 CSS 画的小箭头；数字框等宽数字。
- **勾选框**：1rem，`accent-solid`，与文字间隔 0.5rem，整行可点。
- **来源表**：圆角 0.75rem、1px 边的容器；固定列宽（名称 11rem、权重 6rem、状态 8.5rem，凭据列自适应）；表头 `surface-2` 底、12px/600、`fg-3`；行之间发丝线，悬停时淡淡的 `surface-2`。状态用标签：就绪是中性胶囊（“浏览器渲染 / 官方 API”），未配置是琥珀胶囊加三角图标。
- **吸顶栏与分区导航**：吸顶栏 `bg` 底、下沿发丝线，右侧是“保存设置”主要按钮，保存成功后显示对勾和“已保存”。分区导航是纯文字链接，14px `fg-2`，悬停 `surface-2` 底。

## Do's and Don'ts

### Do:
- **Do** 颜色只取 `lib/base.css` 的令牌；新增颜色同时定义亮暗两套并核对对比度（文字 ≥4.5:1，输入框边 ≥3:1）。
- **Do** 图标只用 `lib/icons.tsx` 里的：24px 网格、1.75 线宽、圆头圆角，用 `font-size` 控制大小。
- **Do** 每种状态都有真实界面：加载用骨架屏而不是居中转圈；空状态说明原因并给下一步；错误说清楚发生了什么并给“重试”；待验证给“前往验证”。
- **Do** 动效只表达状态：颜色和背景过渡 0.15s，缓动 `cubic-bezier(0.16, 1, 0.3, 1)`；所有循环动画（转圈、骨架、进度条、光标）在 `prefers-reduced-motion` 下停掉。
- **Do** 保证键盘可用：`/` 聚焦搜索框，图片预览 ← → Esc，焦点环始终可见；用 `header` / `nav` / `main` 等语义标签，并用 `role="status"` 播报结果数和进度。

### Don't:
- **Don't** 在新标签页加来源芯片、文字徽章、排名数字、分数条或各来源的状态；单个引擎返回的结果不带任何来源标记；被折叠的结果也不带。来源信息只以“引擎小图标”出现；各来源的状态只在设置页和 MCP 输出里。人机验证提示是另一处例外，因为用户必须去处理。（视频结果里的平台名来自结果链接，不算来源。）
- **Don't** 给单条结果加卡片、边框或阴影；结果是页面底上的纯文字行。
- **Don't** 使用 Google 的四色 logo 或其他 Google 品牌元素；保留 Kiwi 自己的字标和靛蓝。
- **Don't** 引入第二个强调色，也不要把琥珀、红当装饰色用。
- **Don't** 用遮罩弹窗承载日常操作；图片预览是停靠面板（窄屏是贴底抽屉），不是模态。
- **Don't** 用 emoji 或 Unicode 符号当图标（早期的 ⚙ 已换成 SVG）。
- **Don't** 在组件 CSS 里写字面颜色（视频时长角标除外）。
