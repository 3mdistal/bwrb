import { afterEach, describe, expect, it } from 'vitest';
import { expandStaticValue } from '../../../src/lib/local-date.js';
import {
  configureLogicalActor,
  resetLogicalActorForTests,
  resolveLogicalActor,
} from '../../../src/lib/logical-actor.js';

afterEach(() => resetLogicalActorForTests());

describe('logical actor provenance', () => {
  it('resolves explicit override, runner environment, then unknown', () => {
    expect(resolveLogicalActor(' codex:session-17 ', { BWRB_ACTOR: 'claude' })).toBe('codex:session-17');
    expect(resolveLogicalActor(undefined, { BWRB_ACTOR: 'claude:runner' })).toBe('claude:runner');
    expect(resolveLogicalActor(undefined, {})).toBe('unknown');
  });

  it('expands $ACTOR from the actor fixed for this process', () => {
    configureLogicalActor('codex:child-reviewer');
    expect(expandStaticValue('$ACTOR')).toBe('codex:child-reviewer');
  });
});
