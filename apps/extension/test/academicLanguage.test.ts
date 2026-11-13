import { describe, expect, it } from 'vitest';
import { parseAcademicLanguage } from '../lib/academicLanguage';

describe('the remembered academic language', () => {
  it('reads "en" as English and everything else, including nothing stored, as no limit', () => {
    expect(parseAcademicLanguage('en')).toBe('en');
    for (const value of ['any', 'zh', 'EN', '', undefined, null, 1, {}]) expect(parseAcademicLanguage(value)).toBe('any');
  });
});
