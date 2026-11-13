import { expect, test } from 'vitest';

test('ci probe: this test must fail', () => {
  expect(1).toBe(2);
});
