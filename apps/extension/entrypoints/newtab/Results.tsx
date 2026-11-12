import type { FusedResult, SearchMode } from '@kiwi-search/core';
import { Fragment, useState, type ReactNode } from 'react';
import { t } from '@/lib/i18n';
import { tr } from '@/lib/i18n/rich';
import { ChevronDownIcon } from '@/lib/icons';
import { WECHAT_SITE_NAME, ZHIHU_SITE_NAME, breadcrumb, clip, compactCount, hiddenLabel, iconHost, siteLabel } from '@/lib/results';
import { Favicon } from './Favicon';
import { SourceMarks } from './SourceMarks';

interface ItemProps {
  result: FusedResult;
  highlighted?: boolean;
  /** Why this result was filtered out, when it is shown in the hidden section. */
  note?: string;
  /** The engines that agree on this result; absent where the list doesn't show them. */
  marks?: ReactNode;
}

function WebResult({ result, highlighted, note, marks }: ItemProps) {
  const date = result.publishedAt?.slice(0, 10);
  const reprintSites = (result.reprints ?? []).slice(0, 3).map((copy, index) => (
    <span key={copy.url}>
      {index > 0 && t('newtab.results.reprintSeparator')}
      <a href={copy.url} target="_blank" rel="noreferrer">
        {copy.host}
      </a>
    </span>
  ));
  return (
    <article className={highlighted ? 'result hl' : 'result'}>
      <div className="site">
        <Favicon host={iconHost(result)} label={siteLabel(result)} />
        <div className="site-text">
          <span className="site-line">
            <span className="site-name">{siteLabel(result)}</span>
            {marks}
          </span>
          <cite>{breadcrumb(result)}</cite>
        </div>
      </div>
      <h3 className="result-title">
        <a href={result.url} target="_blank" rel="noreferrer">
          {result.title}
        </a>
      </h3>
      {(result.snippet || date) && (
        <p className="snippet">
          {date && <span className="date">{date} — </span>}
          {result.snippet}
        </p>
      )}
      {result.reprints && result.reprints.length > 0 && (
        <p className="reprints">
          {result.reprints.length > 3
            ? tr('newtab.results.reprintsMore', { tags: { sites: () => reprintSites }, params: { count: result.reprints.length } })
            : tr('newtab.results.reprints', { tags: { sites: () => reprintSites } })}
        </p>
      )}
      {note && <p className="result-note">{note}</p>}
    </article>
  );
}

function PaperResult({ result, highlighted, note, marks }: ItemProps) {
  const { authors, venue, year, citations, pdfUrl, doi } = result.meta;
  const authorList = authors?.slice(0, 5).join(', ') ?? '';
  const byline = [authors && authors.length > 5 ? t('newtab.results.authorsMore', { authors: authorList }) : authorList, venue, year]
    .filter(Boolean)
    .join(' · ');
  // Source snippets repeat the byline in front of the abstract; the abstract alone reads better here.
  const abstract = clip(result.content ?? result.snippet, 320);
  return (
    <article className={highlighted ? 'result paper hl' : 'result paper'}>
      <h3 className="result-title">
        <a href={result.url} target="_blank" rel="noreferrer">
          {result.title}
        </a>
      </h3>
      {byline && <p className="byline">{byline}</p>}
      {abstract && <p className="snippet">{abstract}</p>}
      <div className="paper-links">
        {pdfUrl && (
          <a href={pdfUrl} target="_blank" rel="noreferrer">
            PDF
          </a>
        )}
        {doi && (
          <a href={`https://doi.org/${doi}`} target="_blank" rel="noreferrer">
            DOI
          </a>
        )}
        {citations !== undefined && <span>{t('newtab.results.cited', { count: citations.toLocaleString() })}</span>}
        {marks}
      </div>
      {note && <p className="result-note">{note}</p>}
    </article>
  );
}

function VideoResult({ result, highlighted, note, marks }: ItemProps) {
  const { video } = result;
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const byline = [siteLabel(result), video?.channel, video?.views, video?.published].filter(Boolean).join(' · ');
  return (
    <article className={highlighted ? 'result video hl' : 'result video'}>
      <a className="video-thumb" href={result.url} target="_blank" rel="noreferrer" tabIndex={-1} aria-hidden="true">
        {video?.thumbnail && !thumbnailFailed && (
          <img src={video.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setThumbnailFailed(true)} />
        )}
        {video?.duration && <span className="video-duration">{video.duration}</span>}
      </a>
      <div className="video-body">
        <h3 className="result-title">
          <a href={result.url} target="_blank" rel="noreferrer">
            {result.title}
          </a>
        </h3>
        {byline && (
          <p className="byline">
            {byline}
            {marks}
          </p>
        )}
        {result.snippet && <p className="snippet">{clip(result.snippet, 180)}</p>}
        {note && <p className="result-note">{note}</p>}
      </div>
    </article>
  );
}

/** What kind of Zhihu card this is, from its link. */
function zhihuKind(url: string): string {
  if (url.includes('/answer/')) return t('newtab.results.zhihuKind.answer');
  return url.includes('zhuanlan.zhihu.com') ? t('newtab.results.zhihuKind.article') : t('newtab.results.zhihuKind.question');
}

function ZhihuResult({ result, highlighted, note, marks }: ItemProps) {
  const { author, votes, comments, age, thumbnail } = result.meta;
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const byline = [
    author,
    votes !== undefined ? t('newtab.results.votes', { count: votes.toLocaleString() }) : '',
    comments !== undefined ? t('newtab.results.comments', { count: comments.toLocaleString() }) : '',
    age,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <article className={highlighted ? 'result zhihu hl' : 'result zhihu'}>
      <div className="zhihu-body">
        <h3 className="result-title">
          <a href={result.url} target="_blank" rel="noreferrer">
            {result.title}
          </a>
        </h3>
        <p className="byline">
          <span className="kind">{zhihuKind(result.url)}</span>
          {byline}
          {marks}
        </p>
        {result.snippet && <p className="snippet">{clip(result.snippet, 240)}</p>}
        {note && <p className="result-note">{note}</p>}
      </div>
      {thumbnail && !thumbnailFailed && (
        <a className="zhihu-cover" href={result.url} target="_blank" rel="noreferrer" tabIndex={-1} aria-hidden="true">
          <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setThumbnailFailed(true)} />
        </a>
      )}
    </article>
  );
}

/** A WeChat official-account article (found through Sogou): text first, the article's thumbnail on the right. */
function WechatResult({ result, highlighted, note, marks }: ItemProps) {
  const { author, thumbnail } = result.meta;
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const byline = [author, result.publishedAt?.slice(0, 10)].filter(Boolean).join(' · ');
  return (
    <article className={highlighted ? 'result zhihu wechat hl' : 'result zhihu wechat'}>
      <div className="zhihu-body">
        <h3 className="result-title">
          <a href={result.url} target="_blank" rel="noreferrer">
            {result.title}
          </a>
        </h3>
        <p className="byline">
          <span className="kind">{t('newtab.results.wechatKind')}</span>
          {byline}
          {marks}
        </p>
        {result.snippet && <p className="snippet">{clip(result.snippet, 240)}</p>}
        {note && <p className="result-note">{note}</p>}
      </div>
      {thumbnail && !thumbnailFailed && (
        <a className="zhihu-cover" href={result.url} target="_blank" rel="noreferrer" tabIndex={-1} aria-hidden="true">
          <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setThumbnailFailed(true)} />
        </a>
      )}
    </article>
  );
}

/** A tweet: who and when, the text, then its counts; the media thumbnail sits on the right. */
function XResult({ result, highlighted, note }: ItemProps) {
  const { comments, reposts, votes, views, thumbnail } = result.meta;
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const stats = [
    comments !== undefined ? t('newtab.results.xReplies', { count: compactCount(comments) }) : '',
    reposts !== undefined ? t('newtab.results.xReposts', { count: compactCount(reposts) }) : '',
    votes !== undefined ? t('newtab.results.xLikes', { count: compactCount(votes) }) : '',
    views !== undefined ? t('newtab.results.xViews', { count: compactCount(views) }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <article className={highlighted ? 'result zhihu tweet hl' : 'result zhihu tweet'}>
      <div className="zhihu-body">
        <h3 className="result-title">
          <a href={result.url} target="_blank" rel="noreferrer">
            {result.title}
          </a>
        </h3>
        {result.publishedAt && <p className="byline">{result.publishedAt.slice(0, 10)}</p>}
        {result.snippet && <p className="snippet tweet-text">{result.snippet}</p>}
        {stats && <p className="byline">{stats}</p>}
        {note && <p className="result-note">{note}</p>}
      </div>
      {thumbnail && !thumbnailFailed && (
        <a className="zhihu-cover" href={result.url} target="_blank" rel="noreferrer" tabIndex={-1} aria-hidden="true">
          <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setThumbnailFailed(true)} />
        </a>
      )}
    </article>
  );
}

/** A Xiaohongshu note inside the general list: cover on the left, title and author line on the right. */
function NoteRow({ result, highlighted, note, marks }: ItemProps) {
  const info = result.note;
  const [coverFailed, setCoverFailed] = useState(false);
  const byline = [t('newtab.results.noteKind'), info?.author, info?.time, info?.likes ? t('newtab.results.noteLikes', { likes: info.likes }) : ''].filter(Boolean).join(' · ');
  return (
    <article className={highlighted ? 'result video note-row hl' : 'result video note-row'}>
      <a className="video-thumb" href={result.url} target="_blank" rel="noreferrer" tabIndex={-1} aria-hidden="true">
        {info?.cover && !coverFailed && (
          <img src={info.cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setCoverFailed(true)} />
        )}
      </a>
      <div className="video-body">
        <h3 className="result-title">
          <a href={result.url} target="_blank" rel="noreferrer">
            {result.title}
          </a>
        </h3>
        <p className="byline">
          {byline}
          {marks}
        </p>
        {note && <p className="result-note">{note}</p>}
      </div>
    </article>
  );
}

/**
 * Which card a result gets. In the general list, results the decision model pulled in from other platforms
 * (a Zhihu answer, a note, a paper) keep the look they have in their own tab.
 */
const itemFor = (mode: SearchMode, result: FusedResult) => {
  if (mode === 'academic') return PaperResult;
  if (mode === 'video') return VideoResult;
  if (mode === 'zhihu') return ZhihuResult;
  if (mode === 'wechat') return WechatResult;
  if (mode === 'x') return XResult;
  if (result.note) return NoteRow;
  if (result.meta.siteName === ZHIHU_SITE_NAME) return ZhihuResult;
  if (result.meta.siteName === WECHAT_SITE_NAME) return WechatResult;
  if (result.meta.authors?.length && result.meta.year !== undefined) return PaperResult;
  return WebResult;
};

/** `plain` leaves the engine marks off: the folded section lists what the filter hid, where they would only distract. */
function Card({ mode, plain, ...props }: ItemProps & { mode: SearchMode; plain?: boolean }) {
  const Item = itemFor(mode, props.result);
  return <Item {...props} marks={plain ? undefined : <SourceMarks sources={props.result.sources} />} />;
}

export function ResultList({
  results,
  mode,
  hoverCite,
  citedUrls,
  between,
}: {
  results: FusedResult[];
  mode: SearchMode;
  hoverCite: number | null;
  citedUrls: Map<string, number>;
  /** A block placed after the first few results (the platform strip), when there are enough results to put it after. */
  between?: { after: number; node: ReactNode };
}) {
  return (
    <div className="result-list">
      {results.map((result, index) => {
        const n = citedUrls.get(result.url);
        return (
          <Fragment key={result.key}>
            <Card mode={mode} result={result} highlighted={n !== undefined && n === hoverCite} />
            {between && index + 1 === between.after && between.node}
          </Fragment>
        );
      })}
      {between && results.length < between.after && between.node}
    </div>
  );
}

/** Results the filter hid, folded away but one click from view so a wrong call is easy to catch. */
export function HiddenResults({ results, mode }: { results: FusedResult[]; mode: SearchMode }) {
  const [open, setOpen] = useState(false);
  if (!results.length) return null;
  return (
    <section className="hidden-results" aria-label={t('newtab.results.hiddenLabel')}>
      <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t('newtab.results.hiddenOpen', { count: results.length }) : t('newtab.results.hiddenClosed', { count: results.length })}
        <ChevronDownIcon className={open ? 'flip' : ''} />
      </button>
      {open && (
        <div className="result-list muted">
          {results.map((result) => (
            <Card key={result.key} mode={mode} result={result} note={result.hidden ? hiddenLabel(result.hidden) : undefined} plain />
          ))}
        </div>
      )}
    </section>
  );
}
