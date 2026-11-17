import type { SourceId } from '@kiwi-search/core';
import { useState } from 'react';
import { t } from '@kiwi-search/app/i18n';
import { confirmSteps } from '@/lib/sourceConfirm';
import { sourceLabel } from '@/lib/sourceMeta';
import { ConfirmDialog } from './controls';

/** The questions before a source that needs a yes is switched on: one for most, three for Baidu. Any "no" leaves it off. */
export function EnableSourceDialog({ id, onEnable, onCancel }: { id: SourceId; onEnable: () => void; onCancel: () => void }) {
  const steps = confirmSteps(id);
  const [index, setIndex] = useState(0);
  const step = steps[index];
  if (!step) return null;
  return (
    <ConfirmDialog
      title={step.title ? t(step.title) : t('options.app.enableTitle', { source: sourceLabel(id) })}
      confirmLabel={t(step.confirm ?? 'options.app.enableConfirm')}
      cancelLabel={step.cancel ? t(step.cancel) : undefined}
      primary={step.primary}
      holdMs={step.holdMs}
      step={index}
      layout={step.layout}
      onConfirm={() => (index + 1 < steps.length ? setIndex(index + 1) : onEnable())}
      onCancel={onCancel}
    >
      {t(step.body)}
    </ConfirmDialog>
  );
}
