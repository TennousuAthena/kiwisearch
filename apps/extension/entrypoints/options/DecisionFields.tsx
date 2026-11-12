import { DEFAULT_SYSTEMONE_ENDPOINT, type FusionConfig } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { Field, SecretInput } from './controls';
import { TestRow, type TestReply } from './TestRow';

type Judge = FusionConfig['judge'];

/** The same request and answer for any service: a short sketch of what to implement; the full text is docs/DECISION-PROVIDERS.md. */
const PROTOCOL = `POST <服务地址>
Authorization: Bearer <Key>
{ "model": "...", "state": { ... }, "questions": { "<id>": { "type": "noul" | "score", "instructions": "...", "criteria": ... } } }

→ { "answers": { "<id>": { "type": "noul", "noul": 0.87 } } }      // 概率 0–1
→ { "answers": { "<id>": { "type": "score", "score": 2 } } }       // 等级 0, 1, 2 …`;

/** Where the dedicated decision model lives: TypeSafe's Jev as a preset, or any service that speaks the same protocol. */
export function DecisionFields({ judge, onChange }: { judge: Judge; onChange: (patch: Partial<Judge>) => void }) {
  const isTypeSafe = judge.endpoint === DEFAULT_SYSTEMONE_ENDPOINT;
  return (
    <>
      <div className="presets" role="group" aria-label="决策模型服务">
        <button type="button" className="btn small" aria-pressed={isTypeSafe} onClick={() => onChange({ endpoint: DEFAULT_SYSTEMONE_ENDPOINT, model: 'jev-latest' })}>
          TypeSafe Jev
        </button>
        <button type="button" className="btn small" aria-pressed={!isTypeSafe} onClick={() => !judge.endpoint || isTypeSafe ? onChange({ endpoint: 'https://', model: '' }) : undefined}>
          自定义服务
        </button>
      </div>
      <div className="field-grid">
        <Field label="服务地址" wide hint={isTypeSafe ? undefined : '任何实现了同一协议的服务都行，包括你自己部署的。'}>
          <input value={judge.endpoint} placeholder="https://decide.example.com/v1/decide" onChange={(event) => onChange({ endpoint: event.target.value.trim() })} />
        </Field>
        <Field label="模型名">
          <input value={judge.model} placeholder="jev-latest" onChange={(event) => onChange({ model: event.target.value })} />
        </Field>
        <Field label="API Key" hint="本机上的服务可以留空。">
          <SecretInput label="决策模型 API Key" value={judge.apiKey} placeholder="粘贴你自己的 Key" onChange={(apiKey) => onChange({ apiKey })} />
        </Field>
      </div>
      <TestRow
        watch={`${judge.endpoint}|${judge.apiKey}|${judge.model}`}
        run={() => browser.runtime.sendMessage({ type: 'kiwi:test-decision', judge: { endpoint: judge.endpoint, apiKey: judge.apiKey, model: judge.model } }) as Promise<TestReply | undefined>}
      />
      <details className="inline-details">
        <summary>想接自己的服务商？协议很简单</summary>
        <p className="note">决策模型回答的是一组小问题：一个是非题的概率，或一个等级。Kiwi 用同一个请求格式问所有服务商，所以任何服务商只要实现下面这个接口就能用：</p>
        <pre className="protocol">{PROTOCOL}</pre>
        <p className="note">完整说明、Kiwi 会问哪些问题、怎样的错误会让它改用聊天模型，见仓库里的 <code>docs/DECISION-PROVIDERS.md</code>。</p>
      </details>
    </>
  );
}
