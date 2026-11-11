import type { AcademicPlan, FusedResult } from '@kiwi-search/core';
import { SparkleIcon } from '@/lib/icons';
import { SOURCE_MARKS } from '@/lib/sourceMarks';
import { ResultList } from './Results';

/**
 * One sentence on what the user's model took the query to mean, and the search text it used, folded away: a researcher
 * wants to see how their words were turned into a search, and nobody else needs to.
 */
export function PlanLine({ plan }: { plan: AcademicPlan }) {
  const queries = Object.entries(plan.queries) as [keyof typeof SOURCE_MARKS, string][];
  if (!plan.intent && !plan.keywords.length) return null;
  return (
    <div className="plan">
      {plan.intent && (
        <p className="plan-intent">
          <SparkleIcon />
          <span>{plan.intent}</span>
        </p>
      )}
      {(plan.keywords.length > 0 || queries.length > 0) && (
        <details className="plan-details">
          <summary>检索式</summary>
          <dl>
            {plan.keywords.length > 0 && (
              <>
                <dt>关键词</dt>
                <dd>{plan.keywords.join(' · ')}</dd>
              </>
            )}
            {queries.map(([id, text]) => (
              <div key={id} className="plan-query">
                <dt>{SOURCE_MARKS[id]?.name ?? id}</dt>
                <dd>
                  <code>{text}</code>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

/** The papers the model named that the index confirmed exist, above the ordinary list. */
export function Landmarks({ results, citedUrls }: { results: FusedResult[]; citedUrls: Map<string, number> }) {
  if (!results.length) return null;
  return (
    <section className="landmarks" aria-labelledby="landmarks-title">
      <h2 id="landmarks-title">核心文献</h2>
      <p className="note">你的 AI 模型认为你最可能要找的论文；每一篇都在文献库里核对过，确实存在。</p>
      <ResultList results={results} mode="academic" hoverCite={null} citedUrls={citedUrls} />
    </section>
  );
}
