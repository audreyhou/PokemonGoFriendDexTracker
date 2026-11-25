'use strict';
/* Share-link API logic, independent of Azure so it can be unit tested with in-memory stores. */
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const DEX_TYPES = ['original', 'shiny', 'lucky', 'xxl', 'xxs', 'shadow', 'purified', 'perfect'];
// Trade wishlist marks: priorities (most wanted first), then Pokémon the trainer does not want in trades.
const WISHLIST_KEYS = ['p0', 'p1', 'p2', 'doNotTrade'];
const MAX_NAME = 30;
const MAX_ID_LENGTH = 64;
const MAX_IDS_PER_TYPE = 5000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_STORED_BYTES = 60 * 1024; // Azure Table binary properties are limited to 64 KiB.
const MAX_WATCH_IDS = 50;
const SHARE_ID = /^[A-Za-z0-9_-]{12}$/;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || '';
  }
}

// Clients only drop a share link when they get one of these codes, not on any 403/404 from Azure.
const NOT_FOUND = 'share_not_found';
const BAD_KEY = 'bad_owner_key';

const newShareId = () => crypto.randomBytes(9).toString('base64url');
const newOwnerKey = () => crypto.randomBytes(32).toString('base64url');
const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

function keyMatches(key, storedHash) {
  if (typeof key !== 'string' || !key || key.length > 200 || typeof storedHash !== 'string') return false;
  const given = Buffer.from(hashKey(key), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && crypto.timingSafeEqual(given, stored);
}

function bearerKey(authorization) {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization || '');
  return match ? match[1] : '';
}

function normalizeUsername(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
}

function parseBody(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BODY_BYTES) throw new HttpError(413, 'the Pokédex is too large');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HttpError(400, 'the request is not valid JSON');
  }
}

/* Same rules as js/storage.js toUser(), so shared trainers import exactly like files do. */
function parseTrainer(raw) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'no trainer was sent');
  const username = normalizeUsername(raw.username);
  if (!username) throw new HttpError(400, 'the trainer has no username');
  const source = raw.dex && typeof raw.dex === 'object' ? raw.dex : {};
  const isEntryId = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
  const dex = {};
  DEX_TYPES.forEach((type) => {
    const ids = new Set();
    if (Array.isArray(source[type])) {
      source[type].forEach((id) => {
        if (isEntryId(id)) ids.add(id);
      });
    }
    if (ids.size > MAX_IDS_PER_TYPE) throw new HttpError(413, 'the Pokédex is too large');
    dex[type] = Array.from(ids).sort();
  });
  // An id listed under several marks keeps the first one (the highest priority).
  const wishlist = source.wishlist && typeof source.wishlist === 'object' ? source.wishlist : {};
  const wanted = new Set();
  dex.wishlist = {};
  WISHLIST_KEYS.forEach((key) => {
    const ids = new Set();
    if (Array.isArray(wishlist[key])) {
      wishlist[key].forEach((id) => {
        if (isEntryId(id) && !wanted.has(id)) ids.add(id);
      });
    }
    ids.forEach((id) => wanted.add(id));
    dex.wishlist[key] = Array.from(ids).sort();
  });
  if (wanted.size > MAX_IDS_PER_TYPE) throw new HttpError(413, 'the Pokédex is too large');
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.length <= 40 && !isNaN(Date.parse(raw.updatedAt))
    ? raw.updatedAt
    : new Date().toISOString();
  return { username, updatedAt, dex };
}

function packDex(dex) {
  const packed = zlib.gzipSync(JSON.stringify(dex), { level: 9 });
  if (packed.length > MAX_STORED_BYTES) throw new HttpError(413, 'the Pokédex is too large');
  return packed;
}

const unpackDex = (packed) => JSON.parse(zlib.gunzipSync(Buffer.from(packed)).toString('utf8'));

function checkId(id) {
  if (typeof id !== 'string' || !SHARE_ID.test(id)) throw new HttpError(404, 'this share link does not exist', NOT_FOUND);
}

/*
 * store:  get(id) -> { record, etag } | null; insert(id, record); replace(id, record, etag); remove(id),
 *         where record = { username, updatedAt, ownerKeyHash, dexGz }. replace() must throw
 *         HttpError(409) when the etag no longer matches.
 * pubsub: notify(id, message); clientUrl(ids) -> WebSocket URL that receives notify() messages for ids.
 */
function createShareApi({ store, pubsub, log = () => {} }) {
  async function load(id) {
    checkId(id);
    const found = await store.get(id);
    if (!found) throw new HttpError(404, 'this share link was turned off or does not exist', NOT_FOUND);
    return found;
  }

  async function loadOwned(id, authorization) {
    const found = await load(id);
    if (!keyMatches(bearerKey(authorization), found.record.ownerKeyHash)) {
      throw new HttpError(403, 'only the trainer who created this link can change it', BAD_KEY);
    }
    return found;
  }

  async function notify(id, message) {
    try {
      await pubsub.notify(id, message);
    } catch (err) {
      log(`Could not send the live update for ${id}: ${err.statusCode || ''} ${err.code || ''} ${err.message}`);
    }
  }

  const view = (id, record) => ({ id, username: record.username, updatedAt: record.updatedAt, dex: unpackDex(record.dexGz) });

  return {
    async create(bodyText) {
      const trainer = parseTrainer(parseBody(bodyText).trainer);
      const ownerKey = newOwnerKey();
      const id = newShareId();
      await store.insert(id, {
        username: trainer.username, updatedAt: trainer.updatedAt, ownerKeyHash: hashKey(ownerKey), dexGz: packDex(trainer.dex),
      });
      return { status: 201, body: { id, ownerKey, updatedAt: trainer.updatedAt } };
    },

    async get(id) {
      const { record } = await load(id);
      return { status: 200, body: view(id, record) };
    },

    /* Lets a browser check an owner key (from a sync link) without changing anything. */
    async verify(id, authorization) {
      const { record } = await loadOwned(id, authorization);
      return { status: 200, body: view(id, record) };
    },

    async update(id, authorization, bodyText) {
      const { record, etag } = await loadOwned(id, authorization);
      const trainer = parseTrainer(parseBody(bodyText).trainer);
      // A browser that was offline must not overwrite newer changes made in another browser.
      if (Date.parse(trainer.updatedAt) < Date.parse(record.updatedAt)) {
        throw new HttpError(409, 'a newer version of this Pokédex was already shared');
      }
      await store.replace(id, {
        username: trainer.username, updatedAt: trainer.updatedAt, ownerKeyHash: record.ownerKeyHash, dexGz: packDex(trainer.dex),
      }, etag);
      await notify(id, { type: 'update', id, updatedAt: trainer.updatedAt });
      return { status: 200, body: { id, updatedAt: trainer.updatedAt } };
    },

    async remove(id, authorization) {
      await loadOwned(id, authorization);
      await store.remove(id);
      await notify(id, { type: 'deleted', id });
      return { status: 204 };
    },

    async negotiate(idsParam) {
      const ids = Array.from(new Set(String(idsParam || '').split(',').filter((id) => SHARE_ID.test(id))));
      if (!ids.length || ids.length > MAX_WATCH_IDS) throw new HttpError(400, `send between 1 and ${MAX_WATCH_IDS} share ids`);
      return { status: 200, body: { url: await pubsub.clientUrl(ids) } };
    },
  };
}

module.exports = { createShareApi, HttpError, parseTrainer, MAX_BODY_BYTES };
