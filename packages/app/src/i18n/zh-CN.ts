import { frontendUx } from './catalog/frontendUx';
import { sessionUx } from './catalog/sessionUx';
import { resultUx } from './catalog/resultUx';
import { settingsUx } from './catalog/settingsUx';
import { common } from './catalog/common';
import { newtab } from './catalog/newtab';
import { options } from './catalog/options';
import { web } from './catalog/web';
import { worker } from './catalog/worker';
import { mergeCatalogs } from './merge';

/** Simplified Chinese: the language the messages are written in, so every other language is measured against it. */
export const zhCN = mergeCatalogs(common, newtab, options, worker, frontendUx, sessionUx, resultUx, settingsUx, web);
