import { describe, expect, it } from 'vitest';

import { getRunCliRetries, withTestCliNodeOptions } from './setup.js';

describe('test CLI spawn environment', () => {
  it('disables transient CLI spawn retries only for the reliability lane', () => {
    expect(getRunCliRetries({})).toBe(2);
    expect(getRunCliRetries({ BWRB_TEST_RELIABILITY: '1' })).toBe(0);
  });

  it('suppresses Node DEP0205 only for source-mode tsx subprocesses', () => {
    expect(withTestCliNodeOptions({}, { useDist: false })).toEqual({
      NODE_OPTIONS: '--disable-warning=DEP0205',
    });

    expect(
      withTestCliNodeOptions({ NODE_OPTIONS: '--trace-warnings' }, { useDist: false })
    ).toEqual({
      NODE_OPTIONS: '--trace-warnings --disable-warning=DEP0205',
    });

    expect(
      withTestCliNodeOptions(
        { NODE_OPTIONS: '--trace-warnings --disable-warning=DEP0205' },
        { useDist: false }
      )
    ).toEqual({
      NODE_OPTIONS: '--trace-warnings --disable-warning=DEP0205',
    });

    expect(withTestCliNodeOptions({}, { useDist: true })).toEqual({});
  });
});
