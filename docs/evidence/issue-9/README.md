# Issue #9：保存标签组生命周期验证

日期：2026-11-17。下列时间均为 UTC。原生截图没有修改或合成；JSON 来自独立 QA 扩展对真实 `tabs.query` / `tabGroups.query` 的只读观察，提交前移除了 URL 查询参数、fragment 和挑战参数。**这些 API 只能证明活动组；保存组计数以原生书签栏和 Tab groups 菜单截图为准。**

## 环境、源码与产物

- 本机 `/Applications/Chromium.app`：**156.0.8078.79 (Official Build, ungoogled-chromium), arm64**，revision `a21ce95c24ce3964416f09ae1862f53f319eb4d0`，macOS 27.2.1 (26B131)。原生 `chrome://version` 见 [版本截图](fixed-chromium-version.png)。
- 基线源码：`3306ac1d3aafac33d726a6e112b2936896137068`，核对时等于 `origin/master` 和既有 `v0.1.0`。加载 `/private/tmp/kiwi-issue9/baseline-extension`，扩展 ID `hioafkeomgfiaccnbbcnlippkoelmbii`；profile `/tmp/kiwi-issue9/chromium-baseline-profile`。
- 修复源码：`d1260bdaf833ef6546d48a07121ffd9c4039db7b`。加载 `/private/tmp/kiwi-issue9/fixed-extension`，扩展 ID `kjagbgdmpfcijicdbnehcconnldbgmdd`；profile `/tmp/kiwi-issue9/chromium-fixed-profile`。[原生管理页](fixed-loaded-extension.png) 确认路径、启用状态和 manifest 版本 `0.1.0`。未改版本、标签或发布资产。
- 基线 ZIP SHA-256：`179cf3d9bc25578fa241f0c633266b7feca6455e9369c290555c79b08bc699a1`。修复 ZIP SHA-256：`70d05e99bf4e5c10aaa82582aae73fed75d64f59eb7d552251d3174cc7d86d89`。保留于 `/tmp/kiwi-issue9/kiwi-search-{baseline,fixed}-chrome-mv3.zip`。
- 修复 background.js SHA-256：`868af3c4ca93c58862fe7f2a759906636d7f3a004bc8feb9f4fcd5481bd64bec`。完整文件哈希见 [builds.json](builds.json)。浏览器由全新构建路径加载，路径由原生管理页确认；本次没有通过 `Debugger.getScriptSource` 获取执行中脚本的独立哈希。
- 没有修改产品计时器、alarm、系统时间或搜索结果，也没有修改/注入保存组状态。没有登录个人账号或填写模型 Key。仅通过产品设置 UI 调整闲置分钟数；GC 原有每分钟检查保持不变。
- 起初为匹配报告版本额外启动过 Chrome for Testing 的空白/引导页，用户纠正后已退出；下面所有搜索、复现和验收都使用已安装 Chromium，不将 Chrome 的启动算作验收。个人 Chromium profile、现有扩展路径和浏览数据未操作。

## 修复前：两次真实 GC 后累积到 3 个保存组

基线通过 [设置 UI](baseline-ui-idle-1-minute.png) 设为 1 分钟。第一次从地址栏 `k` 入口搜索，后续在真实结果页再次搜索。工具在原生地址栏输入时出现重复文本，实际第一条查询是 `Mozilla Firefox documentationMozilla Firefox documentation`，没有将它写成单份查询。

| 观察时间 | 阶段 | 活动内部组 | 关闭保存内部组 | 保存内部组合计 | 原生证据 |
|---|---|---:|---:|---:|---|
| 11:57:41 | 初次搜索，27 条结果 / 3.8 秒 | 1 | 0 | 1 | [首次](baseline-first-opened.png) |
| 12:00:18 | 第一次闲置 GC 后 | 0 | 1 | 1 | [第一次回收](baseline-cycle1-closed.png) |
| 12:02:42 | 再搜 `JavaScript Promise MDN`，19 条 / 6.1 秒 | 1 | 1 | 2 | [再次搜索](baseline-after-cycle1-two-saved.png) |
| 12:05:19 | 第二次真实 GC 后，再搜 `CSS Grid MDN`，26 条 / 3.9 秒 | 1 | 2 | 3 | [第三个保存组](baseline-after-cycle2-three-saved.png) |
| 12:50:06 | 结束前观察：第三轮也已自然回收 | 0 | 3 | 3 | [三个 Closed 项与真实结果](baseline-final-three-closed.png) |

这里的活动/关闭状态取自浏览器原生 Opened/Closed 提示；基线历史阶段没有安装观察扩展，未声称逐周期运行了活动组 API。两次回收之间没有清理保存栏。Google 遇验证码；Bing、DuckDuckGo、Brave 曾返回真实结果，个别查询的 Brave 也遇验证码，不代表所有来源均通过。

## 修复后：内部活动组与内部保存组均为 0

先保持 [默认 10 分钟](fixed-ui-default-10-minutes.png)：地址栏 `k` 入口实际搜索 `TypeScript handbookTypeScript handbook`，23 条真实结果 / 4.2 秒。12:07:05 原生观察到 4 个真实工作标签，全部未分组。随后未改闲置值、未发新查询，至 12:23:10 / 12:23:50 检查时全部工作标签已回收（是大于 10 分钟后的观测，不声称恰好第 10 分钟）。见 [活动状态](fixed-default-collected.json) 和 12:29:18 的 [原生保存组菜单](fixed-default-collected-saved-menu.png)。

12:10:35 建立同名用户组 fixture：先通过原生 Tab → Group Tab 将 fixture 自身标签分组，再点 fixture 的显式按钮，用正式 `tabGroups.update` 仅把自身已分组标签所在组命名为 `Kiwi Search`、设为蓝色。没有按名称扫描或构造保存状态。其来源代码在 [qa-helper](qa-helper/)。观察页本身只有查询和记录功能，命名操作只在独立 fixture 页。

重启前，用户组一直为 `1645804127`、用户标签一直为 `797942733`、window `797942732`，title/color/collapsed、fixture URL 和标签成员均未改变。故以下总组数 1 全部属于用户，不能误读为内部组。

| 观察时间 | 阶段 | 工作标签数 | 活动组总数 / 内部 | 保存组总数 / 内部 | 证据 |
|---|---|---:|---|---|---|
| 12:23:50 | 默认 10 分钟回收后 | 0 | 1 / 0 | 1 / 0 | default-collected JSON；12:29:18 原生菜单 |
| 12:32:36 | UI 已设 1 分钟；`JavaScript Array MDN` | 4 | 1 / 0 | — | [第一轮开始](fixed-cycle1-opened.json) |
| 12:33:09 | 发起后约 61 秒 | 4 | 1 / 0 | — | [实际等待](fixed-cycle1-after-61-seconds.json) |
| 12:34:03 | 已完成来源先回收，验证码来源仍保留 | 1 | 1 / 0 | — | [部分回收](fixed-cycle1-partial-gc.json) |
| 12:34:51 | 第一轮完全回收 | 0 | 1 / 0 | 1 / 0 | [状态](fixed-cycle1-collected.json)、12:35:18 [同一原生菜单](fixed-cycle1-collected-saved-menu.png) |
| 12:36:19 | 回收后快速搜 `CSS Grid MDN` → `CSS Flexbox MDN` | 4 | 1 / 0 | — | [状态](fixed-cycle2-after-rapid-search.json) |
| 12:37:02 | 新窗口搜 `JavaScript Map MDN`，复用相同 4 个 worker ID | 4 | 1 / 0 | — | [复用状态](fixed-cycle2-new-window-reuse.json) |
| 12:39:45 | 第二轮完全回收 | 0 | 1 / 0 | 1 / 0 | [状态](fixed-cycle2-collected.json)、12:40:13 [同一原生菜单](fixed-cycle2-collected-saved-menu.png) |
| 12:41:51 | 第二次回收后再搜 `Web API MDN` | 4 | 1 / 0 | 1 / 0 | [状态](fixed-after-cycle2-search.json)、12:41:37 [同一原生菜单](fixed-after-cycle2-search-saved-menu.png) |

设置 1 分钟的 [UI 证据](fixed-ui-idle-1-minute.png)。第一轮搜索 [27 条 / 3.9 秒](fixed-cycle1-results.png)，第二轮 Flexbox [25 条 / 3.2 秒](fixed-cycle2-results.png)，新窗口 Map [25 条 / 6.1 秒](fixed-new-window-results.png)，第二次回收后 Web API [19 条 / 3.5 秒](fixed-after-cycle2-search-results.png)。Google 常遇验证码，Web API 的 Brave 也未返回结果；Bing/DDG 有真实结果。没有点击绕过验证。验证码等待会延长 worker 生命周期，不能把 1 分钟设置写成所有标签 60 秒整齐消失。

## worker 恢复和浏览器重启

12:22:41 在原生 `chrome://serviceworker-internals` 对准确的产品 scope 点击 Stop（没有 Unregister），页面确认 STOPPED。随后 `JavaScript Array MDN` 成功搜索并建立未分组 workers，见第一轮状态。已验证 worker 停止后的重新唤醒；存活 worker 的 session 复用由直接调用生产 renderer 的回归测试补充，不将其写成另一次原生测试。

12:42 左右仅对固定测试 PID 99586 执行原生 Quit，原生窗口列表确认该 PID 无窗口；用相同 Chromium、profile 和两个加载目录重启，PID 35930，原生进程信息再次确认这些路径。启动期间命令行 observer URL 先出现 ERR_BLOCKED_BY_CLIENT，扩展随后加载并打开 observer 与产品引导页；未将引导页打开当作重新设置。持久化 [闲置设置仍为 1](fixed-restarted-settings-preserved.png)。

重启后 [活动组为 0](fixed-restarted-before-search.json)，但 [原生菜单仍有唯一蓝色用户保存组](fixed-restarted-saved-menu.png)。点击其原生保存栏项后，原 fixture URL 与 `issue9-preserved-tab` 标记恢复，见 [恢复截图](fixed-restarted-user-group.png)。这是真实关闭保存组的恢复；重启后的 session ID 可以变化，不要求跨重启等于旧 ID。

随后从地址栏打开查询 `HTML dialog MDN`，[19 条真实结果 / 3.3 秒](fixed-restarted-search-results.png)，Bing 与 DuckDuckGo 有结果，其他来源仍存在验证码限制。12:47:49 [原生保存菜单](fixed-restarted-search-saved-menu.png) 仍只有 1 个用户组；12:48:23 [观察状态](fixed-restarted-after-search.json) 中用户组为蓝色、1 个原 fixture URL 成员，内部组为 0，工作标签也已再次自然回收。

本机 Chromium 156 的真实保存组生命周期验收通过。12:50:49–12:50:50 结束时，仅关闭两个已核实命令行身份的测试实例，见 [关闭记录](test-browsers-closed.json)；保留 profiles、构建 ZIP 与证据文件，没有删除测试保存组或清浏览器数据。

## 回归与构建

本机 Node 26.13.1 / pnpm 10.12.1；CI 使用项目规定的 Node 24 / pnpm 12。完整输出见 [checks](checks/)。

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm --filter @kiwi-search/core test` | 632 通过 |
| `pnpm --filter @kiwi-search/protocol test` | 35 通过 |
| `pnpm --filter @kiwi-search/app test` | 164 通过 |
| `pnpm --filter @kiwi-search/extension test` | 192 通过 |
| `pnpm --filter @kiwi-search/web test` | 54 通过 |
| `pnpm --filter @kiwi-search/mcp test` | 18 通过 |
| extension / MCP / web build；web `check:dist` | 通过 |

共 1095 条测试。renderer 测试调用生产 `runBrowserEngine`、消息处理、GC 与状态恢复函数，仅 mock 浏览器边界；覆盖两轮 GC/搜索、活动/排队保护、同名组与用户接管、缺失 window/tab、legacy/malformed/session 丢失、worker 模块恢复。它们不枚举真实关闭保存组，不能替代上面的原生验收。初次沙盒 MCP listen EPERM 与 fixture 子资源 DNS 失败后，正常权限复跑均通过；日志保存最终结果。

## 范围与限制

验收目标是在本机 Chromium 156 上阻止新的内部保存组积累，保留用户同名组；旧版本已积累的保存组故意保留。官方 tabGroups API 没有 closed saved-group 枚举、unsave 或 delete 能力，不能可靠判断用户主动保存/改名过的旧组归属，所以升级时不接管 legacy grouped record，也不按名称、URL 或颜色删除。

没有对 Chrome 157、Edge、Firefox 或其他平台做本次真实 UI 验收；CI 的构建通过不等于它们的运行验收。浏览器重启采用本机 Chromium 的现有启动行为；“恢复上次会话”中旧 worker 被恢复为未追踪标签、真实旧版就地升级与用户移动/固定工作标签的原生操作未另跑全套，相关保全策略有生产函数回归覆盖。没有更新个人 Chromium 正在运行的扩展，这是本任务隔离测试要求的范围。
