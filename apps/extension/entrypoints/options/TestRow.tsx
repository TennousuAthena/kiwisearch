import { useEffect, useState } from 'react';
import { t } from '@kiwi-search/app/i18n';
import { CheckIcon, CircleAlertIcon } from '@kiwi-search/app/icons';

export interface TestReply {
  ok: boolean;
  ms?: number;
  error?: string;
}

type Test = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; ms: number } | { state: 'error'; message: string };

/** A "测试连接" button and its answer. `watch` changes whenever what is being tested does, which clears the old answer. */
export function TestRow({ run, watch }: { run: () => Promise<TestReply | undefined>; watch: string }) {
  const [test, setTest] = useState<Test>({ state: 'idle' });
  useEffect(() => setTest({ state: 'idle' }), [watch]);

  async function start() {
    setTest({ state: 'testing' });
    try {
      const reply = await run();
      setTest(reply?.ok ? { state: 'ok', ms: reply.ms ?? 0 } : { state: 'error', message: reply?.error ?? t('options.test.noReply') });
    } catch (error) {
      setTest({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <div className="test-row">
      <button type="button" className="btn" disabled={test.state === 'testing'} onClick={() => void start()}>
        {test.state === 'testing' ? t('options.test.testing') : t('options.test.start')}
      </button>
      <span role="status" className={test.state === 'ok' ? 'test-result ok' : test.state === 'error' ? 'test-result bad' : 'test-result'}>
        {test.state === 'ok' && (
          <>
            <CheckIcon />{' '}
            {test.ms >= 1000 ? t('options.test.connectedSeconds', { seconds: (test.ms / 1000).toFixed(1) }) : t('options.test.connectedMs', { ms: test.ms })}
          </>
        )}
        {test.state === 'error' && (
          <>
            <CircleAlertIcon /> {test.message}
          </>
        )}
      </span>
    </div>
  );
}
