import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AudioObjectStore, TextToSpeechProvider } from '@truevine/audio';
import { hashToken } from '@truevine/auth';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioController } from '../src/audio/audio.controller.js';
import { AudioService } from '../src/audio/audio.service.js';
import type { AudioStore, AudioAssetRecord } from '../src/audio/audio.store.js';
import { AUDIO_STORE, AUDIO_OBJECT_STORE, AUDIO_TTS_PROVIDER } from '../src/audio/audio.tokens.js';
import { AuthExceptionFilter } from '../src/auth/auth-exception.filter.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { OrganizationGuard } from '../src/auth/organization.guard.js';
import { CsrfGuard } from '../src/auth/csrf.guard.js';
import {
  AUTH_STORE,
  AUDIT_STORE,
  ORGANIZATION_STORE,
  PLATFORM_ROLE_STORE,
  TERMS_VERSION,
} from '../src/auth/tokens.js';
import {
  FakeAuthStore,
  FakeAuditStore,
  FakeOrganizationStore,
  FakePlatformRoleStore,
  aUser,
  aMembership,
  aSession,
} from './fakes/auth.fakes.js';

// One synthetic PCM sample in a valid WAV container; never sent to a real provider.
function wav(): Buffer {
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF');
  bytes.writeUInt32LE(38, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(2, 40);
  return bytes;
}

describe('RBAC-003 audio HTTP permissions with fake storage and TTS ports', () => {
  let app: INestApplication;
  let auth: FakeAuthStore;
  let organizations: FakeOrganizationStore;
  const csrf = 'a'.repeat(64);
  const asset: AudioAssetRecord = {
    id: 'asset-a',
    name: 'Synthetic audio',
    source: 'RECORDING',
    mimeType: 'audio/wav',
    storageKey: 'org-1/audio/asset-a.wav',
    checksumSha256: 'a'.repeat(64),
    byteSize: 46n,
    durationMs: null,
    ttsProvider: null,
    ttsVoice: null,
    ttsCharacterCount: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    campaignCount: 0,
  };
  const store = {
    beginOperation: vi.fn<AudioStore['beginOperation']>(),
    completeOperation: vi.fn<AudioStore['completeOperation']>(),
    failOperation: vi.fn<AudioStore['failOperation']>(),
    listAssets: vi.fn<AudioStore['listAssets']>(),
    findPlaybackTarget: vi.fn<AudioStore['findPlaybackTarget']>(),
    recordPlaybackLink: vi.fn<AudioStore['recordPlaybackLink']>(),
  } satisfies AudioStore;
  const objects = {
    putObject: vi.fn<AudioObjectStore['putObject']>(),
    deleteObject: vi.fn<AudioObjectStore['deleteObject']>(),
    createPlaybackUrl: vi.fn<AudioObjectStore['createPlaybackUrl']>(),
  } satisfies AudioObjectStore;
  const tts = {
    providerId: 'synthetic',
    listVoices: vi.fn<TextToSpeechProvider['listVoices']>(),
    synthesize: vi.fn<TextToSpeechProvider['synthesize']>(),
  } satisfies TextToSpeechProvider;
  beforeEach(async () => {
    vi.resetAllMocks();
    store.beginOperation.mockResolvedValue({ state: 'STARTED' });
    store.completeOperation.mockImplementation(async (input) => ({
      ...input,
      byteSize: BigInt(input.byteSize),
      createdAt: asset.createdAt,
      campaignCount: 0,
    }));
    store.listAssets.mockResolvedValue([asset]);
    store.findPlaybackTarget.mockImplementation(async (org, id) =>
      org === 'org-1' && id === asset.id ? asset : undefined,
    );
    objects.createPlaybackUrl.mockResolvedValue('https://playback.example.test/synthetic');
    tts.listVoices.mockReturnValue([{ id: 'Joanna', label: 'Synthetic voice', language: 'en-US' }]);
    tts.synthesize.mockResolvedValue({ body: wav(), contentType: 'audio/wav', voice: 'Joanna' });
    auth = new FakeAuthStore();
    organizations = new FakeOrganizationStore();
    auth.users.push(aUser({ id: 'user-1', email: 'manager@example.test' }));
    await auth.createSession(aSession({ userId: 'user-1', tokenHash: hashToken('audio-session') }));
    await auth.recordTermsAcceptance('user-1', '2026-10-01');
    organizations.memberships.push(
      aMembership({ organizationId: 'org-1', userId: 'user-1', role: 'CAMPAIGN_MANAGER' }),
    );
    const module = await Test.createTestingModule({
      controllers: [AudioController],
      providers: [
        AudioService,
        SessionGuard,
        OrganizationGuard,
        CsrfGuard,
        { provide: AUDIO_STORE, useValue: store },
        { provide: AUDIO_OBJECT_STORE, useValue: objects },
        { provide: AUDIO_TTS_PROVIDER, useValue: tts },
        { provide: AUTH_STORE, useValue: auth },
        { provide: ORGANIZATION_STORE, useValue: organizations },
        { provide: PLATFORM_ROLE_STORE, useValue: new FakePlatformRoleStore() },
        { provide: AUDIT_STORE, useValue: new FakeAuditStore() },
        { provide: TERMS_VERSION, useValue: '2026-10-01' },
        { provide: APP_FILTER, useClass: AuthExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });
  function call(method: 'get' | 'post', suffix = '', org = 'org-1') {
    return request(app.getHttpServer())
      [method](`/organizations/${org}/audio-assets${suffix}`)
      .set('cookie', `tv_session=audio-session; tv_csrf=${csrf}`)
      .set('x-truevine-csrf', csrf)
      .set('idempotency-key', 'synthetic-operation');
  }
  function noOperations() {
    for (const operation of [
      ...Object.values(store),
      ...Object.values(objects),
      tts.listVoices,
      tts.synthesize,
    ])
      expect(operation).not.toHaveBeenCalled();
  }
  const routes = [
    ['get', ''],
    ['get', '/voices'],
    ['post', '/recordings'],
    ['post', '/tts'],
    ['post', '/asset-a/playback-link'],
  ] as const;
  it('allows Campaign Manager listing, voices, recording, synthesis and playback through fake ports', async () => {
    const list = await call('get');
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({ id: asset.id, byteSize: '46' });
    expect(list.body[0]).not.toHaveProperty('storageKey');
    expect(store.listAssets).toHaveBeenCalledWith('org-1');
    expect((await call('get', '/voices')).status).toBe(200);
    const recorded = await call('post', '/recordings')
      .field('name', 'Synthetic recording')
      .attach('file', wav(), { filename: 'sample.wav', contentType: 'audio/wav' });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(store.completeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        actorUserId: 'user-1',
        source: 'RECORDING',
      }),
    );
    const speech = await call('post', '/tts').send({
      name: 'Synthetic speech',
      text: 'Synthetic test',
      voice: 'Joanna',
      organizationId: 'foreign',
    });
    expect(speech.status, JSON.stringify(speech.body)).toBe(201);
    expect(tts.synthesize).toHaveBeenCalledWith({ text: 'Synthetic test', voice: 'Joanna' });
    expect(store.completeOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: 'org-1', actorUserId: 'user-1', source: 'TTS' }),
    );
    expect((await call('post', '/asset-a/playback-link')).status).toBe(201);
    expect(objects.createPlaybackUrl).toHaveBeenCalledWith(asset.storageKey);
    expect(store.recordPlaybackLink).toHaveBeenCalledWith({
      organizationId: 'org-1',
      actorUserId: 'user-1',
      assetId: 'asset-a',
    });
  });
  it.each(routes)(
    'refuses foreign tenant %s %s before any port operation',
    async (method, path) => {
      const response = await call(method, path, 'foreign').send({ organizationId: 'org-1' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('permission_denied');
      noOperations();
    },
  );
  it.each(['BILLING', 'VIEWER'] as const)(
    'refuses audio creation for %s before fake storage or TTS',
    async (role) => {
      organizations.memberships[0]!.role = role;
      for (const path of ['/recordings', '/tts']) {
        const response = await call('post', path).send({
          name: 'Synthetic',
          text: 'Synthetic test',
          voice: 'Joanna',
        });
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('permission_denied');
      }
      noOperations();
    },
  );
  it('conceals foreign and missing asset IDs without signing playback URLs', async () => {
    for (const id of ['foreign-asset', 'missing-asset']) {
      const response = await call('post', `/${id}/playback-link`);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('audio_asset_not_found');
      expect(store.findPlaybackTarget).toHaveBeenCalledWith('org-1', id);
    }
    expect(objects.createPlaybackUrl).not.toHaveBeenCalled();
    expect(store.recordPlaybackLink).not.toHaveBeenCalled();
  });
  it('rechecks membership on the next request without replacing the session', async () => {
    organizations.memberships[0]!.role = 'BILLING';
    expect((await call('get')).status).toBe(403);
    noOperations();
  });
  it('requires accepted terms and CSRF before audio operations', async () => {
    auth.terms.length = 0;
    expect((await call('get')).status).toBe(403);
    await auth.recordTermsAcceptance('user-1', '2026-10-01');
    const response = await request(app.getHttpServer())
      .post('/organizations/org-1/audio-assets/tts')
      .set('cookie', 'tv_session=audio-session')
      .send({ name: 'Synthetic', text: 'Synthetic test', voice: 'Joanna' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('csrf_token_invalid');
    noOperations();
  });
});
