'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createShareApi, HttpError } = require('../src/shares');

function setup() {
  const rows = new Map();
  let version = 0;
  const notices = [];
  const store = {
    async get(id) { return rows.get(id) || null; },
    async insert(id, record) { rows.set(id, { record, etag: String(++version) }); },
    async replace(id, record, etag) {
      if (!rows.has(id) || rows.get(id).etag !== etag) throw new HttpError(409, 'conflict');
      rows.set(id, { record, etag: String(++version) });
    },
    async remove(id) { rows.delete(id); },
  };
  const pubsub = {
    async notify(id, message) { notices.push(message); },
    async clientUrl(ids) { return `wss://example.test/client?groups=${ids.join(',')}`; },
  };
  return { api: createShareApi({ store, pubsub }), rows, notices };
}

const trainer = (updatedAt, original = ['f1']) => ({
  username: '  Ash   Ketchum ', updatedAt, dex: { original, shiny: ['f2', 'f2', 7, ''], bogus: ['x'] },
});
const body = (t) => JSON.stringify({ trainer: t });
const rejects = (promise, status, code) => assert.rejects(promise, (err) => err.status === status && (!code || err.code === code));

test('a shared trainer can be read by anyone and is cleaned like an imported file', async () => {
  const { api } = setup();
  const created = await api.create(body(trainer('2026-11-20T10:00:00.000Z')));
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^[A-Za-z0-9_-]{12}$/);

  const { body: shared } = await api.get(created.body.id);
  assert.equal(shared.username, 'Ash Ketchum');
  assert.deepEqual(shared.dex.original, ['f1']);
  assert.deepEqual(shared.dex.shiny, ['f2']);
  assert.deepEqual(shared.dex.perfect, []);
  assert.equal(shared.dex.bogus, undefined);
});

test('a shared trainer keeps its trade wishlist, with each id at its highest priority', async () => {
  const { api } = setup();
  const t = trainer('2026-11-20T10:00:00.000Z');
  t.dex.wishlist = { p0: ['f4', 7, ''], p1: ['f5', 'f4'], p2: 'not a list', p9: ['f6'], doNotTrade: ['f7', 'f5'] };
  const { body: { id } } = await api.create(body(t));
  assert.deepEqual((await api.get(id)).body.dex.wishlist, { p0: ['f4'], p1: ['f5'], p2: [], doNotTrade: ['f7'] });
});

test('only the owner key can update or turn off a share, and followers are notified', async () => {
  const { api, notices } = setup();
  const { body: { id, ownerKey } } = await api.create(body(trainer('2026-11-20T10:00:00.000Z')));
  const newer = body(trainer('2026-11-20T11:00:00.000Z', ['f1', 'f3']));

  await rejects(api.update(id, 'Bearer wrong-key', newer), 403, 'bad_owner_key');
  await rejects(api.update(id, '', newer), 403);
  await rejects(api.verify(id, 'Bearer wrong-key'), 403);
  assert.equal((await api.verify(id, `Bearer ${ownerKey}`)).body.username, 'Ash Ketchum');

  await api.update(id, `Bearer ${ownerKey}`, newer);
  assert.deepEqual((await api.get(id)).body.dex.original, ['f1', 'f3']);
  assert.deepEqual(notices, [{ type: 'update', id, updatedAt: '2026-11-20T11:00:00.000Z' }]);

  await rejects(api.remove(id, 'Bearer wrong-key'), 403);
  await api.remove(id, `Bearer ${ownerKey}`);
  await rejects(api.get(id), 404, 'share_not_found');
  assert.deepEqual(notices[1], { type: 'deleted', id });
});

test('an older copy from an offline browser cannot overwrite newer changes', async () => {
  const { api } = setup();
  const { body: { id, ownerKey } } = await api.create(body(trainer('2026-11-20T10:00:00.000Z')));
  await api.update(id, `Bearer ${ownerKey}`, body(trainer('2026-11-20T12:00:00.000Z', ['f9'])));
  await rejects(api.update(id, `Bearer ${ownerKey}`, body(trainer('2026-11-20T11:00:00.000Z', ['f1']))), 409);
  assert.deepEqual((await api.get(id)).body.dex.original, ['f9']);
});

test('bad requests are rejected', async () => {
  const { api } = setup();
  await rejects(api.create('not json'), 400);
  await rejects(api.create(body({ username: '   ', dex: {} })), 400);
  await rejects(api.create('x'.repeat(600 * 1024)), 413);
  await rejects(api.get('../../etc'), 404);
  await rejects(api.negotiate(''), 400);
  const { body: negotiated } = await api.negotiate('AAAAAAAAAAAA,bad,AAAAAAAAAAAA');
  assert.equal(negotiated.url, 'wss://example.test/client?groups=AAAAAAAAAAAA');
});
