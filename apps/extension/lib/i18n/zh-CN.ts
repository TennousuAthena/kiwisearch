import { newtab } from './catalog/newtab';
import { options } from './catalog/options';
import { worker } from './catalog/worker';
import { mergeCatalogs } from './merge';

/** Simplified Chinese: the language the messages are written in, so every other language is measured against it. */
export const zhCN = mergeCatalogs(newtab, options, worker);
