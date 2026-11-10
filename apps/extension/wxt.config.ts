import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Kiwi Search',
    description: 'New-tab meta search: Google/Bing/OpenAlex/Exa/DeepSeek… fused, reranked and summarized by AI. Exposes an MCP bridge.',
    permissions: ['storage', 'tabs', 'tabGroups', 'alarms', 'favicon'],
    host_permissions: ['<all_urls>'],
  },
});
