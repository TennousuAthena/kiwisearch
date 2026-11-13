import type { FusedResult } from '@kiwi-search/core';
import { useState } from 'react';
import { t } from '@/lib/i18n';
import { HeartIcon } from '@/lib/icons';

/** Cover shape limits, so one very tall or very flat picture can't dominate a column. */
const MIN_RATIO = 0.6;
const MAX_RATIO = 1.9;

function NoteCard({ result }: { result: FusedResult }) {
  const { note } = result;
  const [coverFailed, setCoverFailed] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  // Height over width; the size comes with the card, so the wall doesn't jump while covers load.
  const ratio = note?.width && note.height ? Math.min(Math.max(note.height / note.width, MIN_RATIO), MAX_RATIO) : 4 / 3;
  const byline = [note?.author, note?.time].filter(Boolean).join(' · ');
  return (
    <a data-result-key={result.key} className="note-card" href={result.url} target="_blank" rel="noreferrer">
      <div className="note-cover" style={{ aspectRatio: `1 / ${ratio}` }}>
        {note?.cover && !coverFailed && (
          <img src={note.cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setCoverFailed(true)} />
        )}
      </div>
      <h3 className="note-title">{result.title}</h3>
      <div className="note-meta">
        <span className="note-author" title={byline}>
          {note?.avatar && !avatarFailed && (
            <img src={note.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setAvatarFailed(true)} />
          )}
          <span>{byline}</span>
        </span>
        {note?.likes && (
          <span className="note-likes" aria-label={t('newtab.notes.likes', { likes: note.likes })}>
            <HeartIcon />
            {note.likes}
          </span>
        )}
      </div>
    </a>
  );
}

export function NoteResults({ results }: { results: FusedResult[] }) {
  return (
    <div className="notes">
      {results.map((result) => (
        <NoteCard key={result.key} result={result} />
      ))}
    </div>
  );
}
