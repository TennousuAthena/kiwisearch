import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Kiwi Search',
    description: 'Kiwi Search: meta search across Google/Bing/OpenAlex/Exa/DeepSeek… fused, reranked and summarized by AI, with an MCP bridge.',
    omnibox: { keyword: 'k' },
    chrome_settings_overrides: {
      search_provider: {
        name: 'Kiwi Search',
        keyword: 'kiwi',
        search_url: 'https://s.kiwi.moe/s?q={searchTerms}',
        favicon_url: 'https://s.kiwi.moe/favicon.ico',
        encoding: 'UTF-8',
        is_default: false,
      },
    },
    permissions: ['storage', 'tabs', 'tabGroups', 'alarms', 'favicon', 'declarativeNetRequestWithHostAccess'],
    host_permissions: ['<all_urls>'],
    web_accessible_resources: [{ resources: ['newtab.html'], matches: ['<all_urls>'] }],
  },
});
