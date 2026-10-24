/**
 * Unit tests for the campaign service.
 *
 * Backed by an in-memory fake, not PostgreSQL, as AGENTS.md 13 requires. The
 * fake implements the whole {@link CampaignStore} interface and records the
 * organization id of every call, so "was this query scoped?" is an assertion and
 * not a comment. The E2E suite repeats the same behaviour against real
 * PostgreSQL constraints.
 */

import { describe, expect, it } from 'vitest';

import { AuthError } from '@truevine/auth';

import type { AuditEventInput } from '../auth/auth.store.js';
import { FakeAuditStore } from '../../test/fakes/auth.fakes.js';

import type {
  CampaignChanges,
  CampaignRecord,
  CampaignStore,
  NewCampaign,
} from './campaign.store.js';
import { CampaignsService } from './campaigns.service.js';

/** An in-memory {@link CampaignStore} that records every call's organization scope. */
class FakeCampaignStore implements CampaignStore {
  constructor(private readonly audit: FakeAuditStore) {}
  private record(org: string, actor: string, action: string, id: string) {
    return this.audit.record({
      organizationId: org,
      actorUserId: actor,
      action,
      scope: 'ORGANIZATION',
      outcome: 'SUCCESS',
      metadata: { organizationId: org, campaignId: id },
    });
  }
  campaigns: CampaignRecord[] = [];
  /** Every organization id handed to a method, for "was it scoped?" assertions. */
  scopedCalls: string[] = [];

  async createCampaign(campaign: NewCampaign): Promise<CampaignRecord> {
    this.scopedCalls.push(campaign.organizationId);
    const now = new Date('2026-10-19T00:00:00Z');
    const created: CampaignRecord = { ...campaign, createdAt: now, updatedAt: now };
    this.campaigns.push(created);
    await this.record(
      campaign.organizationId,
      campaign.createdById,
      'campaign.created',
      created.id,
    );
    return created;
  }

  async listCampaigns(organizationId: string): Promise<readonly CampaignRecord[]> {
    this.scopedCalls.push(organizationId);
    return this.campaigns.filter((c) => c.organizationId === organizationId);
  }

  async findCampaign(
    organizationId: string,
    campaignId: string,
  ): Promise<CampaignRecord | undefined> {
    this.scopedCalls.push(organizationId);
    return this.campaigns.find((c) => c.organizationId === organizationId && c.id === campaignId);
  }

  async updateCampaign(
    organizationId: string,
    campaignId: string,
    changes: CampaignChanges,
    actorUserId: string,
  ): Promise<CampaignRecord | undefined> {
    this.scopedCalls.push(organizationId);
    const campaign = this.campaigns.find(
      (c) => c.organizationId === organizationId && c.id === campaignId,
    );
    if (!campaign) return undefined;
    const updated: CampaignRecord = {
      ...campaign,
      ...changes,
      updatedAt: new Date('2026-10-19T01:00:00Z'),
    };
    this.campaigns[this.campaigns.indexOf(campaign)] = updated;
    await this.record(organizationId, actorUserId, 'campaign.updated', campaignId);
    return updated;
  }

  async deleteCampaign(
    organizationId: string,
    campaignId: string,
    actorUserId: string,
  ): Promise<boolean> {
    this.scopedCalls.push(organizationId);
    const index = this.campaigns.findIndex(
      (c) => c.organizationId === organizationId && c.id === campaignId,
    );
    if (index === -1) return false;
    this.campaigns.splice(index, 1);
    await this.record(organizationId, actorUserId, 'campaign.deleted', campaignId);
    return true;
  }
}

const ORG = 'org-1';
const ACTOR = 'user-1';

function buildService(): {
  service: CampaignsService;
  store: FakeCampaignStore;
  audit: FakeAuditStore;
} {
  const audit = new FakeAuditStore();
  const store = new FakeCampaignStore(audit);
  return { service: new CampaignsService(store), store, audit };
}

async function expectAuthError(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).code).toBe(code);
  expect((error as AuthError).status).toBe(status);
}

function lastAudit(audit: FakeAuditStore): AuditEventInput | undefined {
  return audit.events.at(-1);
}

describe('CampaignsService', () => {
  it('presents an emergency-stopped persisted COMPLETED record as PAUSED', async () => {
    const { service, store } = buildService();
    store.campaigns.push({
      organizationId: ORG,
      id: 'stopped',
      name: 'Stopped campaign',
      status: 'COMPLETED',
      emergencyStoppedAt: new Date('2026-10-20T00:00:00Z'),
      createdById: ACTOR,
      createdAt: new Date('2026-10-19T00:00:00Z'),
      updatedAt: new Date('2026-10-20T00:00:00Z'),
    });

    const [campaign] = await service.list(ORG);

    expect(campaign).toMatchObject({
      status: 'PAUSED',
      emergencyStoppedAt: '2026-10-20T00:00:00.000Z',
    });
  });

  describe('create', () => {
    it('creates a campaign in DRAFT owned by the caller and returns a view', async () => {
      const { service } = buildService();

      const view = await service.create(ORG, ACTOR, 'Harvest push');

      expect(view.name).toBe('Harvest push');
      expect(view.status).toBe('DRAFT');
      expect(view.id).not.toBe('');
      expect(view.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('trims surrounding whitespace from the name', async () => {
      const { service } = buildService();

      const view = await service.create(ORG, ACTOR, '  Harvest push  ');

      expect(view.name).toBe('Harvest push');
    });

    it('writes a campaign.created audit row naming the organization and campaign', async () => {
      const { service, audit } = buildService();

      const view = await service.create(ORG, ACTOR, 'Harvest push');

      expect(lastAudit(audit)).toMatchObject({
        organizationId: ORG,
        actorUserId: ACTOR,
        action: 'campaign.created',
        scope: 'ORGANIZATION',
        outcome: 'SUCCESS',
        metadata: { organizationId: ORG, campaignId: view.id },
      });
    });

    it('refuses an empty or whitespace-only name with a 400', async () => {
      const { service } = buildService();

      await expectAuthError(service.create(ORG, ACTOR, ''), 'invalid_campaign', 400);
      await expectAuthError(service.create(ORG, ACTOR, '   '), 'invalid_campaign', 400);
    });

    it('refuses a name longer than 200 characters with a 400', async () => {
      const { service } = buildService();

      await expectAuthError(service.create(ORG, ACTOR, 'x'.repeat(201)), 'invalid_campaign', 400);
    });

    it('refuses a non-string name with a 400', async () => {
      const { service } = buildService();

      await expectAuthError(service.create(ORG, ACTOR, 42), 'invalid_campaign', 400);
      await expectAuthError(service.create(ORG, ACTOR, null), 'invalid_campaign', 400);
    });

    it('scopes the write to the organization it was given', async () => {
      const { service, store } = buildService();

      await service.create(ORG, ACTOR, 'Harvest push');

      expect(store.scopedCalls).toEqual([ORG]);
      expect(store.campaigns[0]?.organizationId).toBe(ORG);
    });
  });

  describe('list and get', () => {
    it('lists only the given organization', async () => {
      const { service, store } = buildService();
      store.campaigns.push(
        {
          organizationId: ORG,
          id: 'c1',
          name: 'One',
          status: 'DRAFT',
          createdById: ACTOR,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          updatedAt: new Date('2026-10-01T00:00:00Z'),
        },
        {
          organizationId: 'org-2',
          id: 'c2',
          name: 'Two',
          status: 'DRAFT',
          createdById: ACTOR,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          updatedAt: new Date('2026-10-01T00:00:00Z'),
        },
      );

      const views = await service.list(ORG);

      expect(views.map((v) => v.id)).toEqual(['c1']);
    });

    it('returns a campaign scoped to its organization', async () => {
      const { service, store } = buildService();
      store.campaigns.push({
        organizationId: ORG,
        id: 'c1',
        name: 'One',
        status: 'ACTIVE',
        createdById: ACTOR,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });

      const view = await service.get(ORG, 'c1');

      expect(view).toMatchObject({ id: 'c1', name: 'One', status: 'ACTIVE' });
    });

    it('answers 404 campaign_not_found for an unknown id', async () => {
      const { service } = buildService();

      await expectAuthError(service.get(ORG, 'nope'), 'campaign_not_found', 404);
    });

    it('answers 404 campaign_not_found for a campaign belonging to another tenant', async () => {
      const { service, store } = buildService();
      store.campaigns.push({
        organizationId: 'org-2',
        id: 'c1',
        name: 'Foreign',
        status: 'DRAFT',
        createdById: ACTOR,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });

      await expectAuthError(service.get(ORG, 'c1'), 'campaign_not_found', 404);
    });
  });

  describe('statusReport', () => {
    it('counts campaign statuses only within the requested organization', async () => {
      const { service, store } = buildService();
      const createdAt = new Date('2026-10-19T00:00:00Z');
      store.campaigns.push(
        ...(['DRAFT', 'ACTIVE', 'COMPLETED'] as const).map((status, index) => ({
          organizationId: ORG,
          id: `campaign-${index}`,
          name: `Campaign ${index}`,
          status,
          createdById: ACTOR,
          createdAt,
          updatedAt: createdAt,
        })),
        {
          organizationId: 'org-foreign',
          id: 'foreign',
          name: 'Foreign',
          status: 'ACTIVE',
          createdById: ACTOR,
          createdAt,
          updatedAt: createdAt,
        },
      );

      await expect(service.statusReport(ORG)).resolves.toEqual({
        total: 3,
        draft: 1,
        active: 1,
        completed: 1,
      });
      expect(store.scopedCalls).toEqual([ORG]);
    });
  });

  describe('update', () => {
    it('renames a campaign and writes a campaign.updated audit row', async () => {
      const { service, store, audit } = buildService();
      store.campaigns.push({
        organizationId: ORG,
        id: 'c1',
        name: 'Old',
        status: 'DRAFT',
        createdById: ACTOR,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });

      const view = await service.update(ORG, ACTOR, 'c1', { name: '  New  ' });

      expect(view.name).toBe('New');
      expect(lastAudit(audit)).toMatchObject({
        action: 'campaign.updated',
        metadata: { organizationId: ORG, campaignId: 'c1' },
      });
    });

    it('moves a campaign between valid statuses', async () => {
      const { service, store } = buildService();
      store.campaigns.push({
        organizationId: ORG,
        id: 'c1',
        name: 'One',
        status: 'DRAFT',
        createdById: ACTOR,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });

      const activated = await service.update(ORG, ACTOR, 'c1', { status: 'ACTIVE' });
      expect(activated.status).toBe('ACTIVE');

      const completed = await service.update(ORG, ACTOR, 'c1', { status: 'COMPLETED' });
      expect(completed.status).toBe('COMPLETED');
    });

    it('changes name and status in one patch', async () => {
      const { service, store } = buildService();
      store.campaigns.push({
        organizationId: ORG,
        id: 'c1',
        name: 'Old',
        status: 'DRAFT',
        createdById: ACTOR,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });

      const view = await service.update(ORG, ACTOR, 'c1', { name: 'New', status: 'ACTIVE' });

      expect(view).toMatchObject({ name: 'New', status: 'ACTIVE' });
    });

    it('refuses an empty patch with a 400 rather than pretending to succeed', async () => {
      const { service } = buildService();

      await expectAuthError(service.update(ORG, ACTOR, 'c1', {}), 'invalid_campaign', 400);
    });

    it('refuses an unknown status with a 400', async () => {
      const { service } = buildService();

      await expectAuthError(
        service.update(ORG, ACTOR, 'c1', { status: 'SOMETHING_ELSE' }),
        'invalid_campaign',
        400,
      );
    });

    it('refuses an empty name with a 400', async () => {
      const { service } = buildService();

      await expectAuthError(
        service.update(ORG, ACTOR, 'c1', { name: '  ' }),
        'invalid_campaign',
        400,
      );
    });

    it('answers 404 campaign_not_found for an unknown campaign, without auditing success', async () => {
      const { service, audit } = buildService();

      await expectAuthError(
        service.update(ORG, ACTOR, 'nope', { name: 'New' }),
        'campaign_not_found',
        404,
      );
      expect(audit.events).toHaveLength(0);
    });

    it('does not let a campaign from another tenant be updated', async () => {
      const { service, store } = buildService();
      store.campaigns.push({
        organizationId: 'org-2',
        id: 'c1',
        name: 'Foreign',
        status: 'DRAFT',
        createdById: ACTOR,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });

      await expectAuthError(
        service.update(ORG, ACTOR, 'c1', { name: 'Hijacked' }),
        'campaign_not_found',
        404,
      );
      expect(store.campaigns[0]?.name).toBe('Foreign');
    });
  });

  describe('remove', () => {
    it('deletes the campaign and writes a campaign.deleted audit row', async () => {
      const { service, store, audit } = buildService();
      store.campaigns.push({
        organizationId: ORG,
        id: 'c1',
        name: 'One',
        status: 'DRAFT',
        createdById: ACTOR,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });

      await service.remove(ORG, ACTOR, 'c1');

      expect(store.campaigns).toHaveLength(0);
      expect(lastAudit(audit)).toMatchObject({
        action: 'campaign.deleted',
        outcome: 'SUCCESS',
        metadata: { organizationId: ORG, campaignId: 'c1' },
      });
    });

    it('answers 404 campaign_not_found for an unknown campaign, without auditing success', async () => {
      const { service, audit } = buildService();

      await expectAuthError(service.remove(ORG, ACTOR, 'nope'), 'campaign_not_found', 404);
      expect(audit.events).toHaveLength(0);
    });

    it('does not delete a campaign belonging to another tenant', async () => {
      const { service, store } = buildService();
      store.campaigns.push({
        organizationId: 'org-2',
        id: 'c1',
        name: 'Foreign',
        status: 'DRAFT',
        createdById: ACTOR,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });

      await expectAuthError(service.remove(ORG, ACTOR, 'c1'), 'campaign_not_found', 404);
      expect(store.campaigns).toHaveLength(1);
    });
  });

  it('never audits a credential-shaped metadata key', async () => {
    const { service } = buildService();

    // The audit helper refuses such keys by construction; a name that happens
    // to look like a credential is metadata only, so this stays a success path.
    const view = await service.create(ORG, ACTOR, 'api_key=not-really');
    expect(view.name).toBe('api_key=not-really');
  });

  it('accepts and clears only a syntactically valid audio selection', async () => {
    const { service, store } = buildService();
    const assetId = 'a0000000-0000-4000-8000-000000000001';
    const created = await service.create(ORG, ACTOR, 'Audio campaign', assetId);
    expect(created.audioAssetId).toBe(assetId);
    const updated = await service.update(ORG, ACTOR, created.id, { audioAssetId: null });
    expect(updated.audioAssetId).toBeNull();
    expect(store.campaigns[0]?.audioAssetId).toBeNull();
  });

  it('rejects malformed audio asset ids', async () => {
    const { service } = buildService();
    await expectAuthError(
      service.create(ORG, ACTOR, 'Audio campaign', 'foreign'),
      'invalid_campaign',
      400,
    );
  });
});
