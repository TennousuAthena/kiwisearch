import type { FusionConfig } from '@kiwi-search/core';
import { DomainInput } from './controls';

interface Props {
  config: FusionConfig;
  onChange: (update: (config: FusionConfig) => FusionConfig) => void;
}

/** Site rules. They work without any key: blocked sites are folded away, boosted ones move up. */
export function FiltersSection({ config, onChange }: Props) {
  const setJudge = (patch: Partial<FusionConfig['judge']>) => onChange((c) => ({ ...c, judge: { ...c.judge, ...patch } }));
  return (
    <section className="section" id="filters" aria-labelledby="filters-title">
      <h2 id="filters-title">屏蔽与偏好</h2>
      <p className="lead">按网站调整结果，不需要任何 Key。输入域名后按回车，也可以直接粘贴一串。</p>
      <div className="card">
        <div className="card-body flat">
          <DomainInput label="不想看到的网站" values={config.judge.blockedDomains} onChange={(blockedDomains) => setJudge({ blockedDomains })} placeholder="例如 example.com" />
          <p className="note">这些网站的结果会被折叠到页面底部，可以展开查看。</p>
        </div>
      </div>
      <div className="card">
        <div className="card-body flat">
          <DomainInput label="优先显示的网站" values={config.judge.boostedDomains} onChange={(boostedDomains) => setJudge({ boostedDomains })} placeholder="例如 wikipedia.org" />
          <p className="note">这些网站的结果排名会提高。</p>
        </div>
      </div>
    </section>
  );
}
