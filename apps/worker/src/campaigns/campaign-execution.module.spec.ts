import { CALLBACK_SOURCES } from '@truevine/telephony';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FailClosedDispatchCostPolicy,
  SyntheticDispatchCostPolicy,
} from '../reliability/dispatch-cost-policy.js';
import {
  loadCallbackSource,
  loadDispatchCostPolicy,
  loadExecutionMode,
} from './campaign-execution.module.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('campaign callback binding source', () => {
  it('uses the provider namespace when the provider adapter is selected', () => {
    expect(loadCallbackSource({ AT_VOICE_PROVIDER: 'true' })).toBe(CALLBACK_SOURCES.africasTalking);
  });

  it('uses the fake namespace for every non-provider adapter selection', () => {
    expect(loadCallbackSource({})).toBe(CALLBACK_SOURCES.fake);
    expect(loadCallbackSource({ AT_VOICE_PROVIDER: 'false' })).toBe(CALLBACK_SOURCES.fake);
  });
});

describe('W6-01 isolated execution configuration', () => {
  it('recognises the w601-test execution mode', () => {
    expect(loadExecutionMode({ CAMPAIGN_EXECUTION_MODE: 'w601-test' })).toBe('w601-test');
    expect(loadExecutionMode({})).toBe('disabled');
  });

  it('permits a synthetic reserve only for an explicitly isolated fake mode', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AT_VOICE_PROVIDER', '');
    expect(loadDispatchCostPolicy('w601-test')).toBeInstanceOf(SyntheticDispatchCostPolicy);
    expect(loadDispatchCostPolicy('disabled')).toBeInstanceOf(FailClosedDispatchCostPolicy);

    vi.stubEnv('AT_VOICE_PROVIDER', 'true');
    expect(loadDispatchCostPolicy('w601-test')).toBeInstanceOf(FailClosedDispatchCostPolicy);
  });
});
