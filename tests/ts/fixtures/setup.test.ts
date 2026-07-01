import { describe, expect, it } from 'vitest';

import { withTestCliNodeOptions } from './setup.js';

describe('test CLI spawn environment', () => {
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
