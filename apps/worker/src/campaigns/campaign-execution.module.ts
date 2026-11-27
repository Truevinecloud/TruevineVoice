import { Module } from '@nestjs/common';
import {
  AfricaTalkingVoiceAdapter,
  CALLBACK_SOURCES,
  FakeVoiceAdapter,
  type CallbackSource,
  type VoicePort,
} from '@truevine/telephony';

import {
  DISPATCH_COST_POLICY,
  FailClosedDispatchCostPolicy,
  SyntheticDispatchCostPolicy,
} from '../reliability/dispatch-cost-policy.js';
import { DispatchGuard } from '../reliability/dispatch-guard.service.js';
import { DATABASE_CLIENT } from '../tokens.js';
import { CampaignExecutionClaimService } from './campaign-execution-claim.service.js';
import {
  CAMPAIGN_EXECUTION_MODE,
  CampaignExecutionProcessor,
  type CampaignExecutionMode,
} from './campaign-execution.processor.js';
import { CampaignCallInitiationService } from './campaign-call-initiation.service.js';
import {
  CallInitiationReconciliationService,
  type ReconciliationClient,
} from './call-initiation-reconciliation.service.js';

export function loadExecutionMode(env: NodeJS.ProcessEnv = process.env): CampaignExecutionMode {
  const raw = env['CAMPAIGN_EXECUTION_MODE'];
  if (raw === 'disabled' || raw === 'w402-test' || raw === 'w601-test' || raw === 'local') {
    return raw;
  }
  return 'disabled';
}

function loadVoiceAdapter(env: NodeJS.ProcessEnv = process.env): VoicePort {
  if (env['AT_VOICE_PROVIDER'] === 'true') {
    const username = env['AT_USERNAME'];
    const apiKey = env['AT_API_KEY'];
    const voiceNumber = env['AT_VOICE_NUMBER'];
    const environment = env['AT_ENVIRONMENT'] as 'SANDBOX' | 'PRODUCTION' | undefined;

    if (!username || !apiKey || !voiceNumber || !environment) {
      throw new Error(
        'AT_VOICE_PROVIDER=true requires AT_USERNAME, AT_API_KEY, AT_VOICE_NUMBER and AT_ENVIRONMENT.',
      );
    }

    return new AfricaTalkingVoiceAdapter({
      username,
      apiKey,
      voiceNumber,
      environment,
      fetch,
    });
  }

  return new FakeVoiceAdapter();
}

/**
 * The callback namespace is part of a durable binding key, so it is derived
 * from the selected adapter rather than from a mutable process role name. This
 * keeps fake, provider and synthetic receipts in separate namespaces.
 */
export function loadCallbackSource(env: NodeJS.ProcessEnv = process.env): CallbackSource {
  return env['AT_VOICE_PROVIDER'] === 'true'
    ? CALLBACK_SOURCES.africasTalking
    : CALLBACK_SOURCES.fake;
}

export function loadDispatchCostPolicy(mode: CampaignExecutionMode) {
  const isolated =
    process.env['AT_VOICE_PROVIDER'] !== 'true' &&
    process.env['NODE_ENV'] !== 'production' &&
    (mode === 'local' ||
      ((mode === 'w402-test' || mode === 'w601-test') && process.env['NODE_ENV'] === 'test'));
  // No tariff is approved in this repository. Only an explicitly isolated fake
  // adapter may use a synthetic reserve; every other mode fails closed.
  return isolated ? new SyntheticDispatchCostPolicy(1_000n) : new FailClosedDispatchCostPolicy();
}

@Module({
  providers: [
    CampaignExecutionProcessor,
    { provide: CAMPAIGN_EXECUTION_MODE, useFactory: loadExecutionMode },
    {
      provide: DISPATCH_COST_POLICY,
      useFactory: loadDispatchCostPolicy,
      inject: [CAMPAIGN_EXECUTION_MODE],
    },
    {
      provide: DispatchGuard,
      useFactory: (policy: SyntheticDispatchCostPolicy | FailClosedDispatchCostPolicy) =>
        new DispatchGuard(policy),
      inject: [DISPATCH_COST_POLICY],
    },
    CampaignExecutionClaimService,
    { provide: 'VOICE_PORT', useFactory: loadVoiceAdapter },
    {
      provide: CallInitiationReconciliationService,
      useFactory: (prisma: ReconciliationClient) => new CallInitiationReconciliationService(prisma),
      inject: [DATABASE_CLIENT],
    },
    {
      provide: CampaignCallInitiationService,
      useFactory: (
        claimService: CampaignExecutionClaimService,
        voice: VoicePort,
        prisma: unknown,
        reconciliation: CallInitiationReconciliationService,
        dispatchGuard: DispatchGuard,
      ) =>
        new CampaignCallInitiationService(
          claimService,
          voice,
          prisma as never,
          loadCallbackSource(),
          reconciliation,
          dispatchGuard,
        ),
      inject: [
        CampaignExecutionClaimService,
        'VOICE_PORT',
        DATABASE_CLIENT,
        CallInitiationReconciliationService,
        DispatchGuard,
      ],
    },
  ],
  exports: [
    CampaignExecutionProcessor,
    CampaignExecutionClaimService,
    CampaignCallInitiationService,
    CallInitiationReconciliationService,
  ],
})
export class CampaignExecutionModule {}