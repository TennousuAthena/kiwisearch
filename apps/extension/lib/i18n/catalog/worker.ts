/** Messages produced outside a page: the service worker, the tab renderer, the bridge, and the texts core asks for through `Env.messages`. Keys start with `worker.`, `omnibox.` or `core.`. */
export const worker = {
  'omnibox.suggestion': '用 Kiwi Search 搜索：%s',

  'worker.renderer.pageNotOpened': '页面没有按预期打开：网络不通、网站拒绝了这次访问，或跳转到了其他页面',
  'worker.renderer.needsLogin': '需要在这个浏览器里登录',
  'worker.renderer.needsVerification': '需要在搜索引擎页面手动完成人机验证',
  'worker.renderer.refused': '网站拒绝了这次访问：{reason}',

  'worker.bridge.answerNeedsApi': 'MCP answer 需要 API 摘要提供方；请在 Kiwi Search 设置中选择 OpenAI 兼容 API。',
  'worker.bridge.missingQuery': 'MCP 请求缺少 query',

  'worker.builtinModel.unsupported': '当前浏览器不支持内置模型',
  'worker.builtinModel.noContent': '浏览器内置模型没有生成内容，请稍后重试。',

  'worker.blocklist.noRules': '没有读到可用的规则，这个地址返回的可能不是屏蔽列表',
  'worker.blocklist.storageFull': '浏览器的存储空间不足，无法保存这个列表',

  // What core says to the user itself; `lib/i18n/coreMessages.ts` hands these to core as `Env.messages`. core has the same
  // sentences as its defaults (`DEFAULT_CORE_MESSAGES`), and `test/coreMessages.test.ts` keeps the two from drifting apart.
  'core.noAiModel': '没有可用的 AI 模型',
  'core.planInvalid': '模型的回复不是有效的检索计划',
  'core.judgeEmpty': '决策模型没有给出可用的判定',
  'core.decisionNotJson': '决策模型的回复不是 JSON',
  'core.noDecisionModel': '没有可用的决策模型',
  'core.judgeTimedOut': '超过 {ms}ms，已使用已返回的判定',
  'core.intentTimedOut': '超过 {ms}ms，只搜索通用来源',
  'core.customListName': '自定义规则',
} as const;
