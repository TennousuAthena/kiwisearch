import type { FusedResult } from '@kiwi-search/core';
import { useState } from 'react';
import { PLATFORM_NAMES, clip, compactCount, platformOf, type Platform } from '@/lib/results';

function Card({ result, highlighted }: { result: FusedResult; highlighted: boolean }) {
  const platform = platformOf(result) as Platform;
  const { author, votes, thumbnail } = result.meta;
  const note = result.note;
  const [coverFailed, setCoverFailed] = useState(false);
  const cover = note?.cover ?? thumbnail;
  const byline = [
    note?.author ?? author,
    votes !== undefined ? `${compactCount(votes)} 赞同` : '',
    note?.likes ? `${note.likes} 赞` : '',
    result.publishedAt?.slice(0, 10),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <article className={highlighted ? 'pcard hl' : 'pcard'}>
      <p className="pcard-head">
        <span className="kind">{PLATFORM_NAMES[platform]}</span>
        {byline}
      </p>
      <div className="pcard-body">
        <div className="pcard-text">
          <h3>
            <a href={result.url} target="_blank" rel="noreferrer">
              {result.title}
            </a>
          </h3>
          {result.snippet && <p>{clip(result.snippet, 120)}</p>}
        </div>
        {cover && !coverFailed && <img src={cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setCoverFailed(true)} />}
      </div>
    </article>
  );
}

/**
 * Posts from the platforms (Zhihu, Xiaohongshu, WeChat) that a general search pulled in, side by side under one heading,
 * so the reader sees what each community says without switching tabs. Each card is one post; the links under them go to
 * the platform's own tab for the rest.
 */
export function PlatformStrip({
  results,
  hoverCite,
  citedUrls,
  onOpenTab,
}: {
  results: FusedResult[];
  hoverCite: number | null;
  citedUrls: Map<string, number>;
  onOpenTab: (platform: Platform) => void;
}) {
  const present = [...new Set(results.map((r) => platformOf(r) as Platform))];
  return (
    <section className="platforms" aria-labelledby="platforms-title">
      <h2 id="platforms-title">各平台怎么说</h2>
      <div className="pgrid">
        {results.map((result) => {
          const n = citedUrls.get(result.url);
          return <Card key={result.key} result={result} highlighted={n !== undefined && n === hoverCite} />;
        })}
      </div>
      <p className="pmore">
        {present.map((platform) => (
          <button key={platform} type="button" className="status-action" onClick={() => onOpenTab(platform)}>
            在{PLATFORM_NAMES[platform]}里看更多 →
          </button>
        ))}
      </p>
    </section>
  );
}
