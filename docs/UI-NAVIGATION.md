# 设置与搜索结果的界面改版

2026-11-21。用户应能先完成当前任务，再按需调整参数。沿用 Kiwi 的系统字体、品牌色、来源标记和单列结果样式。

## 设计依据

| 官方资料 | 在 Kiwi 的应用 |
|---|---|
| [Apple HIG · Settings](https://developer.apple.com/design/human-interface-guidelines/settings) | 为常见操作提供可直接使用的默认值。创建同步组时使用已配置的中继。 |
| [Google · Canonical layouts](https://developer.android.com/develop/ui/views/layout/canonical-layouts) | 桌面并列目录与当前分区，窄屏一次看一层，返回可回到目录。 |
| [Google Search · 结果筛选](https://support.google.com/websearch/answer/142143) | 先选择结果类型，再在模式栏下调整当次搜索条件。 |
| [Microsoft · App settings](https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings) | 同步类别用即时开关。「立即同步」放在状态旁。连接地址输入完整后显式应用。 |
| [IBM Carbon · Accordion](https://carbondesignsystem.com/components/accordion/usage/) | 必须比较的来源状态保持可见，仅将可选细节收起。 |
| [VS Code · Settings](https://code.visualstudio.com/docs/configure/settings) | 支持直达设置项，已自定义的中继可单独恢复默认。 |

## 设置目录

| 分区 | 主要任务 |
|---|---|
| 常规 | 界面偏好、界面来源和默认搜索设置。入门说明链接到各设置的实际编辑位置。 |
| 搜索源 | 在同一行查看名称、启用状态和需要处理的问题，按需展开密钥或打开登录页。 |
| AI 功能 | 按概览、智能筛选和重排组织；启用后显示模型、共用关系和连接测试。 |
| 结果过滤 | 管理屏蔽、优先显示的网站及订阅规则。结果页的屏蔽操作也能在这里撤销。 |
| 设备同步 | 首次选择创建或加入；已加入时显示设备、连接状态和同步范围。 |
| 高级选项 | 同步连接、搜索与排序、AI 参数、MCP 和维护。重置放在其生效范围内。 |

## 分批修改与验收

1. **设备同步。** 用户选择创建后确认名称；选择加入后输入恢复短语并选择如何处理本机设置。创建后展示短语和另一台设备上的下一步。已连接页提供立即同步、设备和同步范围。中继地址、恢复默认和 STUN 只在「高级选项 → 同步连接」编辑，入组前即可配置。验收覆盖默认创建、加入、预配置自建中继、故意留空中继、改名与重新打开，检查旧设备配置和默认关闭的密钥同步开关。
2. **设置导航。** 桌面一次显示一个分区，窄屏从目录进入，保留分区地址、刷新和后退。验证从入门入口直达来源、修改密钥后切换分区的自动保存、键盘焦点以及调整窗口宽度时的当前位置。
3. **搜索结果。** 顶部依次为搜索框、模式、模式筛选；新闻时间和学术年份与排序位置固定。状态一行展示，需要处理的问题就近给操作；快速答案和详细概览共用回答区，引用紧跟文字。验证新闻改时间、学术改年份、打开引用后返回、图片切换、窄屏当前模式可见。

## 交付检查

用已有 Chromium 配置备份并激活扩展，核对运行版本、扩展 ID、原有设置和界面。自动测试、实际走过的流程和仍待验证的场景分别记录在对应的 internals 文档与 STATUS 中。
