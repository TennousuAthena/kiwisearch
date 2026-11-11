import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Kiwi Search',
    description: 'Kiwi Search: meta search across Google/Bing/OpenAlex/Exa/DeepSeek… fused, reranked and summarized by AI, with an MCP bridge.',
    omnibox: { keyword: 'k' },
    permissions: ['storage', 'tabs', 'tabGroups', 'alarms', 'favicon', 'declarativeNetRequestWithHostAccess'],
    host_permissions: ['<all_urls>'],
    web_accessible_resources: [{ resources: ['newtab.html'], matches: ['<all_urls>'] }],
  },
});
