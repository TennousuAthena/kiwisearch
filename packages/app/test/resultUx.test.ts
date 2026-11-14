import { describe, expect, it } from 'vitest';
import { summaryCopyText } from '../src/lib/resultUx';

describe('copying an overview with evidence', () => {
  const citations = [
    { n: 1, title: 'First source', url: 'https://one.example/article' },
    { n: 2, title: 'Second\n source', url: 'https://two.example/article' },
    { n: 3, title: 'Unused', url: 'https://unused.example/article' },
  ];

  it('keeps original numbering and includes only references present in the copied portion', () => {
    expect(summaryCopyText('A detail [2].', citations, 'Sources')).toBe('A detail [2].\n\nSources\n\n[2] Second source\nhttps://two.example/article');
  });

  it('includes a reference once even if repeatedly cited or repeated in the snapshot', () => {
    const copied = summaryCopyText('One [1], another [2], again [1].', [...citations, citations[0]], 'Sources');
    expect(copied.match(/https:\/\/one.example\/article/g)).toHaveLength(1);
    expect(copied).not.toContain('unused.example');
  });

  it('does not interpret ordinary Markdown link labels as evidence citations', () => {
    expect(summaryCopyText('A [1](https://one.example).', citations, 'Sources')).toBe('A [1](https://one.example).');
  });

  it('does not add unsafe source URLs and preserves an uncited answer without an empty source section', () => {
    expect(summaryCopyText('Partial [4].', [{ n: 4, title: 'Unsafe', url: 'javascript:alert(1)' }], 'Sources')).toBe('Partial [4].');
    expect(summaryCopyText('  A partial answer.  ', citations, 'Sources')).toBe('A partial answer.');
  });
});
