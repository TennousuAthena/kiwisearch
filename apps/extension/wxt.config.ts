import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Firefox has no `_favicon` endpoint and warns about the permission.
  manifest: ({ browser }) => ({
    name: 'Kiwi Search',
    icons: { 16: '/icon/16.png', 32: '/icon/32.png', 48: '/icon/48.png', 128: '/icon/128.png' },
    description: 'Kiwi Search: meta search across Google/Bing/OpenAlex/Exa/DeepSeek… fused, reranked and summarized by AI, with an MCP bridge.',
    omnibox: { keyword: 'k' },
    // `webRequest` only observes: it reads where a Google result link redirects to (`lib/redirectTarget.ts`).
    permissions: ['storage', 'tabs', 'tabGroups', 'alarms', ...(browser === 'firefox' ? [] : ['favicon']), 'declarativeNetRequestWithHostAccess', 'webRequest'],
    host_permissions: ['<all_urls>'],
    // The toolbar button opens the extension's own interface. Not an override of the new-tab page: where that is shown is the user's choice.
    action: { default_title: 'Kiwi Search' },
    // Only for "open the extension's own interface when the website cannot be reached"; asked for when the user turns that on.
    optional_permissions: ['webNavigation'],
    // Navigations that a web page starts to the extension's own page need this; the browser's own (address bar, `k`) do not. Only the Kiwi sites.
    web_accessible_resources: [{ resources: ['app.html'], matches: ['https://s.kiwi.moe/*', 'https://kiwi.moe/*'] }],
  }),
});
