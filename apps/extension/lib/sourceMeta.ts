import type { SourceId } from '@kiwi-search/core';
import { t } from '@kiwi-search/app/i18n';

/** Name of a source for the settings page (the message `source.label.<id>`, typed so no source can lack one); search results deliberately don't show where they came from. */
export const sourceLabel = (id: SourceId): string => t(`source.label.${id}`);
