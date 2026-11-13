import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Firefox has no `_favicon` endpoint and warns about the permission.
  manifest: ({ browser }) => ({
    name: 'Kiwi Search',
    icons: { 16: '/icon/16.png', 32: '/icon/32.png', 48: '/icon/48.png', 128: '/icon/128.png' },
    description: 'Kiwi Search: meta search across Google/Bing/OpenAlex/Exa/DeepSeek… fused, reranked and summarized by AI, with an MCP bridge.',
    omnibox: { keyword: 'k' },
    permissions: ['storage', 'tabs', 'tabGroups', 'alarms', ...(browser === 'firefox' ? [] : ['favicon']), 'declarativeNetRequestWithHostAccess'],
    host_permissions: ['<all_urls>'],
    web_accessible_resources: [{ resources: ['newtab.html'], matches: ['<all_urls>'] }],
  }),
});
