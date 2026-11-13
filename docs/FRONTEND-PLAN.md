# Kiwi Search 前端改进计划

日期：2026-11-13。状态：品牌接入已完成，后续批次 1–6 均为待实施、待验收计划。

目标是让一次搜索更顺畅：输入有帮助，等待有解释，结果便于扫读，返回时不丢阅读位置，AI 和偏好设置可以随时控制。保留 Kiwi 的叶绿品牌、朴素结果列、多源搜索和用户自有浏览器/登录/Key 的边界。现行视觉规则见 [DESIGN.md](../DESIGN.md)，项目路线见 [PLAN.md](PLAN.md)，实际完成与验证状态见 [STATUS.md](STATUS.md)。

## 1. 依据与观察范围

### 实际打开竞品后观察到的内容

2026-11-13，在桌面浏览器、暗色、英文界面、UK 地区设置下，以 `mechanical keyboard` 为同一查询检查 DuckDuckGo 与 Brave Search；DuckDuckGo 输入建议使用了前缀 `mechanical key`，通过建议选中该查询。这是一次受控的小范围比较，不代表所有地区、语言、查询或设备上的布局。

| 产品 | 已观察 | 尚未验证 |
|---|---|---|
| DuckDuckGo | 输入建议出现，能用上下键选取；结果页有模式导航，以及地区、安全搜索、时间条件；打开了搜索设置面板；结果菜单有仅搜索此站、排除此站和屏蔽站点入口 | 没有对站点动作做持久修改，也没有验证所有筛选组合；没有在此查询中完整生成、重试 AI 回答 |
| Brave Search | 同一查询中有 Ask / All / Images / News / Videos / Maps / Goggles；折叠的 Filters 含 UK、Anytime、安全与本地相关条件；Discussions 条目有日期、评论、点赞信息；看到了 Quick settings 入口 | Quick settings 打开过程遇到重绘，未取得稳定面板；具体设置项只作官方页面核对。没有验证 AI 完整生成流程、Rerank 修改或所有模式 |

可借鉴的是交互层次：常用条件靠近搜索框，偶尔使用的操作进入菜单，来源信息与文章内容分清，AI 有明确控制入口。Kiwi 的来源能力不统一，不能照搬一组看似有效、实际未传给来源的地区或安全筛选。

### 官方资料核对

| 资料 | 本计划采用的事实与用途 |
|---|---|
| [DuckDuckGo Search Settings](https://duckduckgo.com/settings) | 搜索设置包含自动补全开关；本次面板观察用于比较常用设置的位置，不据此声称其所有设置都已测试 |
| [DuckDuckGo Keyboard Shortcuts](https://duckduckgo.com/duckduckgo-help-pages/features/keyboard-shortcuts) | 官方说明支持搜索框聚焦、结果移动与打开，并可关闭快捷键；用于完善 Kiwi 的键盘路径 |
| [DuckDuckGo 日期筛选](https://duckduckgo.com/duckduckgo-help-pages/features/dates) | 官方将日期条件放在搜索框下方；Kiwi 借鉴条件的位置，但只提供自身来源可执行的范围 |
| [DuckDuckGo Search Assist](https://duckduckgo.com/duckduckgo-help-pages/results/ai-assisted-answers) | 官方说明回答带来源，可展开，并可选择自动出现频率、按需或关闭；用于设计 Kiwi 的摘要控制，属于文档核对 |
| [Brave AI in Search](https://search.brave.com/help/ai) | 官方区分带来源的简短 AI Answers 与可追问的 Ask Brave；Kiwi 先改善现有概览，多轮追问后置 |
| [Brave Rerank](https://search.brave.com/help/rerank) | 官方说明用户可提高或排除域名；Kiwi 已有域名规则，后续把可撤销入口放到结果旁，不另造一套规则 |
| [Brave Search Settings](https://search.brave.com/settings) | 官方设置页包含主题、自动 AI 回答、新标签打开等选项；用于快捷设置的信息架构，未声称 Quick settings 面板已实测 |
| [Brave Discussions](https://search.brave.com/help/discussions) | 官方把讨论内容作为常规结果的补充；Kiwi 已有社区聚合，后续改善其相关性与元数据，不另堆一个重复模块 |

这些资料提供功能与交互参考；下面的优先级、状态模型和验收条件是结合 Kiwi 代码作出的设计决定。

### Kiwi 代码审计的边界

已阅读新标签页、搜索 session/reducer、结果与概览组件、设置页及自动保存逻辑。发现的“断连可能留在 loading”“来源错误信息未留在页面状态”“后退会重跑查询”等结论来自代码路径。本次没有为这些情形执行故障注入，不能写成已在真实浏览器复现。每批开工先补足对应证据。

现有能力应保留并回归，而非重复开发：

- `/` 聚焦并全选查询；提交后更新 URL；浏览器前进/后退能恢复查询、模式与新闻条件。
- 渐进部分结果、软截止后的补充结果、登录/验证入口、隐藏结果及其原因。
- 新闻发布时间范围、排序、手动刷新、概览过期提示；学术年份、被引排序与语言限定。
- 社区菜单的 Esc 关闭、焦点返回与视口边界处理；图片预览的左右键和 Esc。
- AI 概览、数字引用、鼠标关联结果、宽屏右栏与窄屏折叠。
- 设置分区、来源分组/预设、连接测试、自动保存、首次引导，以及亮暗主题和 reduced-motion。

来源与模式正在扩展；具体清单以 registry、配置与当前组件为准，计划不固定来源数量。新闻、购物等并行工作须在每批开始时核对，避免覆盖其代码和文档。

## 2. 阶段与依赖

| 批次 | 优先级 / 状态 | 用户能感知的完成结果 | 主要依赖 |
|---|---|---|---|
| 0：品牌接入 | 已完成 | 主页、结果页、设置和扩展图标使用一致的绿色标志 | 见独立的实际浏览器验证记录 |
| 1：结束与恢复 | P0 | 搜索不会无解释地一直等待；空结果有正确下一步；设置失败能重试 | session/reducer、来源统计、自动保存状态 |
| 2：历史与阅读稳定 | P1 | 后退恢复刚才的列表和阅读位置；迟到结果不打断阅读 | 批次 1 的终止状态与会话隔离 |
| 3：输入与模式条件 | P1 | 可用键盘选建议；模式条件清楚、可清除、可随 URL 恢复 | 批次 2 的查询状态边界；来源能力表 |
| 4：结果与来源操作 | P1 | 更快判断是否打开；可查看来源、调整站点并撤销 | 批次 1 的写入恢复；批次 2 的列表稳定 |
| 5：AI 控制与引用 | P1 | 概览按需生成、可停止/重试，来源可检查，正文布局稳定 | 批次 1、2；独立摘要请求与引用快照 |
| 6：设置与跨屏收尾 | P2 | 常用偏好随手可改，来源容易找到，键盘和触屏流程完整 | 批次 1；复用批次 3–5 的控制与持久化接口 |

阶段 0 已于 2026-11-13 在原 Chromium 身份与加载路径中完成：检查了首页、结果页、设置页的亮暗六种状态，以及 favicon 和扩展图标；刚更新后，606 项本地存储与备份完全一致。后续搜索正常更新了图标缓存和来源状态，最终配置、桥接数据和同步存储未变。详细范围见 [品牌验证记录](internals/newtab-page.md#product-logo-and-browser-icons) 与 [STATUS.md](STATUS.md)。

后续六批各自形成可审核的改动和验收记录，不把全部前端改进捆成一次大重构，也不承诺固定工期。批次 3、4 在共同依赖稳定后可独立进行；批次 5 的协议设计可提前，页面接入仍需等待状态边界明确。

下文文件缩写中，`lib/` 指 `apps/extension/lib/`，`newtab/` 与 `options/` 指 `apps/extension/entrypoints/` 下的对应目录，`core/` 指 `packages/core/src/`。新建 helper 名称是实施建议，开工时再确定。

## 3. 批次 1：搜索断连、空状态与设置恢复（P0）

**现状证据。** [useSearchSession.ts](../apps/extension/lib/useSearchSession.ts) 在 keepalive 失败或端口断开时清理引用，但没有相应的可恢复终止状态；[App.tsx](../apps/extension/entrypoints/newtab/App.tsx) 仍按 stage/running 显示进度。[searchState.ts](../apps/extension/lib/searchState.ts) 将 `source_error` 与 `source_done` 一样用于移除 running，未保留错误；[Status.tsx](../apps/extension/entrypoints/newtab/Status.tsx) 的空态主要区分等待验证与通用无结果。[OptionsApp.tsx](../apps/extension/entrypoints/options/OptionsApp.tsx) 初始化未处理读取失败，加载前先显示默认配置；[useAutosave.ts](../apps/extension/entrypoints/options/useAutosave.ts) 写入失败后依靠下一次修改再试。这些是需验证的代码风险。

**计划改动。**

- 区分正常完成、用户停止、意外中断；主动取消旧查询不产生错误提示。中断时保留已有结果，停止等待并给出重试。统一 keepalive、模型 abort、port 清理，拒收旧会话的迟到事件。
- 保留来源成功/失败/等待信息；优先利用已有 `PipelineResult.sourceStats`。页面默认仍是简短状态行，诊断详情按需展开。
- 为“未配置可用来源、来源请求全部失败、被筛选清空、真正无匹配、仍待登录/验证”提供不同下一步；部分失败不盖住成功结果。若现有事件不足以区分缺 Key 与未启用，只扩充必要的 readiness 原因。
- 设置初始化增加 loading/error/retry；读取完成前不允许编辑默认值。保存失败保留草稿，提供显式重试；区分 config 与 bridge 的部分写入结果，不能误报全部保存成功。

**涉及文件。** `lib/useSearchSession.ts`、`lib/searchState.ts`、`newtab/{App,Status}.tsx`、`options/OptionsApp.tsx`、`options/useAutosave.ts`、`lib/settings.ts`、两套 message catalogs；必要时涉及 `lib/messages.ts`、background 和 core 的统计类型。实施前阅读 [pipeline](internals/pipeline.md)、[newtab-page](internals/newtab-page.md)、[config-and-storage](internals/config-and-storage.md)、[interface-text](internals/interface-text.md)。

**验收。**

1. 在“尚无结果、已有部分结果、摘要生成中”三个时刻注入端口中断，页面均能结束 loading、解释状态并重试；已到结果保留。
2. 连续提交 A/B 后，A 的迟到结果、错误与摘要不能写进 B；主动停止不显示系统故障。
3. 五类空态分别得到正确行动；筛选清空时清除入口可见；仅有核心论文或隐藏结果时不显示自相矛盾的“没有任何结果”。
4. 登录/验证完成后的既有补充结果流程仍工作；软截止后仍在加载与真正结束的视觉、朗读状态一致。
5. 设置读失败能恢复，写失败可直接重试；慢写期间再次修改最终保留最新值；关闭/隐藏页面保留现有 flush 行为；config 与 bridge 凭据不被默认值覆盖。

**依赖与边界。** 不先增加自动重试网络请求，避免来源限流和模型重复费用。用户点重试才发起下一次搜索。故障注入使用模拟事件或隔离 QA，不清空用户真实存储。

## 4. 批次 2：历史快照与阅读稳定（P1）

**现状证据。** [App.tsx](../apps/extension/entrypoints/newtab/App.tsx) 的 `popstate` 调用 `go()`，会重跑查询并重置学术年份/排序；[useSearchSession.ts](../apps/extension/lib/useSearchSession.ts) 随即换成 emptyState。URL 历史已经存在，缺的是结果、概览与阅读位置快照。[searchState.ts](../apps/extension/lib/searchState.ts) 的融合/重排/迟到事件直接替换列表；实际跳动幅度尚待浏览器测量。

**计划改动。**

- 给每个 history entry 分配标识，在当前标签页内存中保存有限数量快照：已提交查询、模式/条件、结果、摘要/引用、筛选、展开状态、选中图片、阅读锚点。内存快照与后台来源缓存分开，暂不持久保存整份浏览历史。
- 后退/前进先恢复快照；已结束的快照不自动重跑模型。被打断的快照明确显示暂停/恢复入口。刷新与重新搜索是显式行动。
- 新查询回到列表起点；恢复时以结果 key 加视口偏移定位。迟到结果与重排保留当前阅读锚点；当更新会扰动已读区域时提供“有新结果”入口，而非无声移动正在阅读的条目。
- 将学术条件与新闻条件的持久范围写清：本次搜索条件、跨次偏好、URL 可分享条件分别管理，避免后退改变全局偏好。

**涉及文件。** `newtab/App.tsx`、`lib/{useSearchSession,searchState,results}.ts`、`newtab/{Overview,ImageResults,Results}.tsx`；建议新增小型 history/session helper，避免把全部逻辑继续塞进 App。

**验收。** 搜 A、滚到第 8 条、展开概览，搜 B 后再后退，立即恢复 A 的结果与阅读位置；前进恢复 B；不会额外调用模型。恢复图片选择、新闻条件与学术排序；淘汰旧快照后有明确重新搜索行为。模拟晚到、隐藏和排序变化，当前锚点尽量保持，不能让焦点落到不存在的元素。

**依赖。** 使用批次 1 的会话隔离和终止状态；须在列表更新策略中保留排名与过滤语义，不能只为稳定视觉永久冻结旧结果。

## 5. 批次 3：搜索建议与模式筛选（P1）

**现状证据。** [SearchBox.tsx](../apps/extension/entrypoints/newtab/SearchBox.tsx) 已有 autofocus、清除与 `/`，没有建议列表。[ModeTabs.tsx](../apps/extension/entrypoints/newtab/ModeTabs.tsx) 已有社区收纳、Esc 归焦和防溢出；[NewsToolbar.tsx](../apps/extension/entrypoints/newtab/NewsToolbar.tsx) 已有新闻条件。学术条件在 App 中，其他模式可用条件需逐源确认。

**计划改动。**

- 先做可关闭、可清除的本地近期查询建议，默认只使用当前会话中用户已提交的查询。跨会话保留作为明确偏好；外部自动补全另列扩展，不默认发送未提交内容。
- 使用可访问的 combobox/listbox：输入法组合时不提交，建议选择与普通 Enter 行为一致；保留清除、Esc、上下键和点击选择。
- 根据模式显示可用工具，先整理已有新闻与学术条件；选中条件可一处清除，URL/后退能恢复约定范围内的条件。
- 建立条件能力表，区分来源端检索与本页过滤。地区、安全搜索、网页时间等，只有在适配器确实支持并有测试后才呈现；不从日期不明的摘要推断精确发表时间。

**涉及文件。** `newtab/{SearchBox,ModeTabs,NewsToolbar,App}.tsx`、`lib/{results,news,academicLanguage}.ts`、新增建议状态 helper；跨会话保留若加入，经过 `settings.ts` 与配置默认值。新增来源端条件还会涉及 core/types、来源适配器、缓存键和 MCP 参数，单独评审。

**验收。** 中文输入法、键盘、鼠标操作都能选建议且不重复提交；Esc 还原输入草稿；删除或关闭历史立即生效；没有未经配置的远程建议请求。新闻范围/排序/刷新及社区菜单现有行为不回退。切换模式后只保留适用条件；链接重载与后退一致；320px 下模式与工具不遮挡弹出菜单。

**依赖。** 批次 2 明确草稿、已提交查询和历史条目边界。通用来源尚不支持的条件不阻塞第一版建议与现有工具整理。

## 6. 批次 4：结果扫描、来源弹出与可撤销站点操作（P1）

**现状证据。** [Results.tsx](../apps/extension/entrypoints/newtab/Results.tsx) 网页摘要直接呈现来源片段，视频/知乎已有截断；[SourceMarks.tsx](../apps/extension/entrypoints/newtab/SourceMarks.tsx) 有朗读标签和 hover/focus 展开，但名称主要依赖 `title`。[FiltersSection.tsx](../apps/extension/entrypoints/options/FiltersSection.tsx) 已有屏蔽/提升域名，结果旁没有入口。是否需要压缩间距、长摘要是否影响首屏，需先用代表性内容测量。

**计划改动。**

- 保留 42rem 结果列、蓝色链接、网站名/地址/日期层次。以长短中文/英文样本确定摘要默认行数，必要时提供展开；不统一改成卡片，不删掉判断来源需要的元数据。
- 社区聚合仍根据实际命中与查询需要出现，保留既有条数限制和“看更多”入口；只有来源提供日期、评论或互动数时才展示，新闻/论文/视频/购物继续各用适合的信息结构，不补造数据。
- 来源堆叠支持点击/Enter 弹出名称列表，hover/focus 效果继续保留。说明用“收录”，不把多引擎返回当事实核验；Brave 两种渠道等品牌别名继续合并。
- 结果菜单区分临时与持久行动：“本次仅看此站”“本次排除此站”先明确作用于已取得结果；“以后屏蔽此站”“提高此站优先级”复用已有域名规则。
- 持久操作显示目标域名与可撤销反馈；撤销只反转本次增加/删除的规则，不能把整份旧 config 覆盖回去。当前结果及时反馈；若重新检索或重排，沿用批次 2 的阅读稳定策略。

**涉及文件。** `newtab/{Results,SourceMarks,PlatformStrip}.tsx`、`newtab/style.css`、`lib/{sourceMarks,domains,settings}.ts`、`options/FiltersSection.tsx`；必要时新增受控的域名规则更新消息，由 background 串行合并写入。规则匹配与优先级遵循 [blocklists](internals/blocklists.md) 和 [fusion](internals/fusion.md)。

**验收。** 桌面鼠标、Tab/Enter/Esc、触屏均能查看所有来源并关闭弹层；不形成遮挡标题的常驻徽章。长摘要不会挤掉日期或唯一关键说明。临时站点条件不写入永久屏蔽；持久屏蔽可撤销且保存其他并发设置；已有子域匹配/白名单/订阅规则优先级不变；错误写入有重试反馈。

**依赖。** 批次 1 的保存恢复与批次 2 的列表更新机制。设置页当前保存整份 config；在结果页增加写入口前，必须先解决两个页面同时改规则的覆盖风险。

## 7. 批次 5：AI 概览控制与引用检查（P1）

**现状证据。** [Overview.tsx](../apps/extension/entrypoints/newtab/Overview.tsx) 只在生成完成后折叠，窄屏生成过程可能持续推移结果；错误入口主要是去设置。引用经 [markdown.ts](../apps/extension/lib/markdown.ts) 转成安全链接，已有鼠标高亮，但没有同等的键盘 focus 联动。新闻已经维护引用快照、摘要时间与过期提示，不能重做时丢掉。

**计划改动。**

- 概览提供自动、按需、关闭三个清晰选择；设置已有 summary 开关应迁移/兼容，而不是再造冲突开关。当前搜索的生成/停止/重试与长期偏好分开。
- loading 与 streaming 起就控制窄屏占用高度，允许展开；宽屏保留右栏。停止或失败保留已有文本，给出恰当状态。
- 复制概览时保留引用编号和来源清单；引用焦点与鼠标同样关联结果，按需展开来源标题/域名，外链保留安全属性。
- 设计单独的摘要重试/按需入口，复用明确的结果与 citation snapshot；不能用重跑全部搜索来伪装“仅重试摘要”。新检索数据若进入摘要，先建立新快照并清晰标示。

**涉及文件。** `newtab/Overview.tsx`、`lib/{markdown,useSearchSession,searchState,messages}.ts`、background、`core/{pipeline,summarize,types,config}.ts`、`options/AiSection.tsx` 和 catalogs。需阅读 [summary-and-language](internals/summary-and-language.md)；core 仍经 Env 取能力，不接 browser API。

**验收。** 自动/按需/关闭符合配置且不重复调用模型；按需未触发时无摘要请求。生成长回复时列表阅读位置稳定；停止保留文本，重试只影响概览；浏览器内置模型和外部提供方均覆盖失败/中断。键盘访问引用能检查来源；复制内容可追溯引用。新闻迟到报道不暗改现有引用，仍正确提示概览过期。

**依赖与后置。** 依赖批次 1、2 及摘要请求隔离。多轮 Ask、对话历史、深度研究与分享不进入此批；它们需要独立的上下文、来源快照、成本和存储设计，不能只加一个聊天框。

## 8. 批次 6：快捷设置、来源查找与跨屏收尾（P2）

**现状证据。** 结果页设置入口打开完整 options 页；[SourcesSection.tsx](../apps/extension/entrypoints/options/SourcesSection.tsx) 按组展示全部来源，缺少名称搜索与需处理视图。设置导航没有当前分区状态。[controls.tsx](../apps/extension/entrypoints/options/controls.tsx) 的 radio group 缺少方向键移动，SwitchRow 的文字未实际关联点击；[ImageResults.tsx](../apps/extension/entrypoints/newtab/ImageResults.tsx) 的全局方向键未排除文本输入目标。现有图像预览、社区菜单和首次引导基础都可复用。

**计划改动。**

- 页面快捷设置只放高频偏好：外观（跟随系统/浅色/深色）、结果打开方式、摘要模式；复杂来源/Key/规则仍进入完整设置。外观继续复用绿色 tokens；手动主题要覆盖引擎 logo 的暗色变体逻辑，不能只改背景。
- 设置增加来源名称查找、已启用/需处理视图，导航标记当前分区；从空态或快捷设置可直达相关 section。现有预设继续保留，应用结果应明确且可撤销。
- 补齐 radio 方向键、开关标签、焦点归还、可关闭弹层、快捷键帮助。图片预览打开时，输入框内的左右键只移动光标；触屏主要操作目标以 44px 为设计目标。
- 统一检查亮暗主题、320/390/768/1280px 布局、200% 缩放、长中文与英文、系统 reduced-motion。根据实际阅读任务调间距和吸顶需求，不新增装饰性大面板。

**涉及文件。** `newtab/{App,ImageResults,ModeTabs,SearchBox}.tsx`、`options/{OptionsApp,SourcesSection,controls}.tsx`、两页样式、`lib/base.css`、`lib/settings.ts`、`lib/sourceIcons.ts` 及主题偏好 helper。主题偏好、结果打开方式与摘要模式共用唯一持久化接口，避免两套设置互相覆盖。

**验收。** 快捷设置和完整设置双向一致，刷新保留选择；任何入口都不会重写 Key。通过来源名能定位配置，筛选只影响展示；需处理项可进入对应修复动作。全部关键任务可仅用键盘完成，弹层关闭后焦点回到合理位置；图片方向键不劫持文本编辑；缩放和窄屏下无不可达控件。全站对比度与状态文字逐项检查，不将一次配色计算表述成完整无障碍认证。

**依赖。** 复用批次 1 的保存恢复、批次 3 的输入/条件行为、批次 4 的弹层与批次 5 的摘要模式。明确的键盘缺陷可在相关批次提前修复，最后统一回归。

## 9. 首批开工清单与共同完成条件

下一次开始前端实现时，先完成批次 1，按以下顺序落地：

1. 记录当前代码与正在进行的新闻/购物/品牌改动；核对 session、reducer、来源统计的真实类型，不复制本文中的旧快照。
2. 写出状态转移表：主动换查询、用户停止、正常 done、仍有迟到来源、端口意外断开、摘要中断。每种状态明确是否保留结果、是否仍期待事件、可用行动。
3. 用可控 port/事件替身复现三阶段断连与 A/B 交错；记录实际结果，再补必要的状态处理。不要只写镜像实现的测试。
4. 保留来源统计并建立空态决策函数，分别覆盖无可用源、全部失败、部分成功、筛选清空和等待验证；需要协议扩充时先写明原因。
5. 设置加载失败与保存重试独立实现；覆盖慢写、连续修改、部分写失败和 tab hide，保持凭据与原配置。
6. 界面文字放入 catalogs；运行相关扩展测试、文案检查与 typecheck。修改 core 协议时补相应 core/MCP 验证，不把已有空 experiments 包的根 test 失败算成本批新增故障。
7. 构建并在用户既有 Chromium 身份和路径激活；按 [testing.md](internals/testing.md) 先在仓库外安全备份设置，核对运行代码、manifest、UI 与存储。故障注入和模拟配置留在隔离 QA，不能覆盖用户真实配置。
8. 在对应 internals 主题文件和 STATUS 记绝对日期、实际测试结果、未测试范围；只有满足本批验收才把其状态改为完成。

每批交付应包含可复现的用户操作、最小必要测试和真实页面检查。浏览器检查至少覆盖首页、正在加载、部分结果、完成、空态、失败、需要验证，以及受本批影响的 AI/图片/新闻/购物/学术状态。未涉及的模式按风险选择回归，不承诺一次覆盖所有来源站点。

阶段 0 的品牌工作已有独立验证记录。批次 1–6 的实现与验收进展见后续记录；“实现已接入”不等同于所有真实环境验收均已完成。


## 10. 实现进展（2026-11-13）

六批主要功能已接入现有产品，并更新到原 Chromium 身份与路径：

| 批次 | 已实现 | 本次验证边界 |
|---|---|---|
| 1 | 搜索停止/断连恢复、来源诊断、分原因空态、设置读取重试/串行保存/失败草稿、关闭前立即交接 | 实测停止保留 45 条结果；断连与存储失败用 mock 测试 |
| 2 | 12 条内存快照、前进后退恢复、结果阅读锚点、快照失效后的显式重新搜索 | 实测结果与滚动位置恢复；图片/学术/新闻完整组合待实测 |
| 3 | 本标签页近期查询、方向键/Enter/Esc、IME 提交保护、导航清理建议状态 | 实测键盘选择与 Esc 还原；中文输入法待实测 |
| 4 | 三行摘要、完整来源弹层、临时站点条件、持久屏蔽/提高优先级与定向撤销 | 实测四来源弹层和临时筛选；持久撤销通过并发单测，未实机写入 |
| 5 | 自动/按需/关闭、独立生成/停止/重试、固定阅读区、引用来源、复制带来源 | 实测按需生成、停止、重试和带引用文本；未完成所有提供方故障与复制实测 |
| 6 | 快捷偏好、亮暗/系统主题、打开方式、来源查找/需处理、分组撤销与键盘修正 | 实测首页与快捷设置亮暗；完整设置与 320px/200% 跨屏验收待补 |

545 项核心、235 项扩展、17 项 MCP 测试通过，工作区类型检查和构建通过。原配置、Key、桥接数据和同步存储保留；临时验证偏好已恢复。桌面工具在真实检查中途连续报 `cgWindowNotFound`，因此未把剩余跨屏、输入法与设置交互写成通过。具体观察、备份位置和最后设置时序修补的部署范围见 [新标签页验证记录](internals/newtab-page.md#integrated-verification--2026-11-13)。
