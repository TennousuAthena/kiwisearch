# Config and storage

The config version and migrations, defaults for new fields, and what the extension keeps in `chrome.storage.local`. Overview and rules: [AGENTS.md](../../AGENTS.md). Chinese overview for people: [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

## Config version and migrations

Config has a `version` (`CONFIG_VERSION`); put rewrites of stored configs in `MIGRATIONS` in `config.ts`. `baidu` is off by default and last in `BROWSER_ENGINES` (the options page groups sources by content type in `lib/sourceCatalog.ts`, in the order of that file): its result page mixes in widgets (translate cards, recommendation lists, hosts like `nourl.ubs.baidu.com`) that the parser reads as results. Migration 2→3 switched it off in stored configs, and switching it on in the options page opens a confirmation dialog (`confirm` in its `SOURCE_INFO` entry). New fields only need defaults.

## Settings storage and the options page

Settings are in `chrome.storage.local` under `config` and `bridge` (`lib/settings.ts`); `onboarding` remembers that the first-run guide was finished, and `sourceStatus` (`lib/sourceStatus.ts`, pure part in `lib/sourceHealth.ts`) keeps what the last search that touched each source found (ok / empty / login / captcha / error), written from the pipeline events by the background and the MCP bridge. The options page (`entrypoints/options/`) autosaves (`useAutosave.ts`), groups sources by content type (`lib/sourceCatalog.ts`, typed over `SourceId`) and shows each source's status from `sourceStatus` (`lib/sourceView.ts`); the "测试连接" button sends `kiwi:test-llm` to the background (`lib/llmTest.ts`). `loadConfig` runs `migrateConfig`, then deep-merges over `DEFAULT_CONFIG`, so new config fields need defaults in `config.ts`.
