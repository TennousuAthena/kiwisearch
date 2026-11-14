import { mountSearchApp } from '@kiwi-search/app';
import { createExtensionHost } from '@/lib/extensionHost';

mountSearchApp(document.getElementById('root')!, createExtensionHost());
