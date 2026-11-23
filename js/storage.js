/* Trainer profiles: localStorage persistence and the shareable file format. */
(function () {
  'use strict';

  const STORAGE_KEY = 'pogo-friend-dex/v1';
  const FILE_APP = 'pokemon-go-friend-dex';
  const FILE_VERSION = 1;
  const DEX_TYPES = ['original', 'shiny', 'lucky', 'xxl', 'xxs', 'shadow', 'purified', 'perfect'];
  const MAX_NAME = 30;
  const SHARE_ID = /^[A-Za-z0-9_-]{12}$/;
  const OWNER_KEY = /^[A-Za-z0-9_-]{20,200}$/;

  function normalizeUsername(name) {
    return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
  }

  function userKey(name) {
    return normalizeUsername(name).toLowerCase();
  }

  function emptyDex() {
    const dex = {};
    DEX_TYPES.forEach((type) => { dex[type] = new Set(); });
    return dex;
  }

  function createUser(username) {
    return { username: normalizeUsername(username), updatedAt: new Date().toISOString(), dex: emptyDex() };
  }

  /* Live share link of a trainer. The owner (the browser that created the link, or one synced
     with its private sync link) holds the key needed to publish changes; followers only read. */
  function toShare(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !SHARE_ID.test(raw.id)) return null;
    if (raw.role === 'follower') return { id: raw.id, role: 'follower' };
    if (raw.role !== 'owner' || typeof raw.ownerKey !== 'string' || !OWNER_KEY.test(raw.ownerKey)) return null;
    return { id: raw.id, role: 'owner', ownerKey: raw.ownerKey, syncedAt: typeof raw.syncedAt === 'string' ? raw.syncedAt : '' };
  }

  /* Validates untrusted data (localStorage, an imported file or a share link). Unknown entry ids
     are kept so a file made with newer Pokédex data does not lose progress. Share details are
     only read from this browser's own storage, never from files. */
  function toUser(raw, withShare) {
    if (!raw || typeof raw !== 'object') return null;
    const username = normalizeUsername(raw.username);
    if (!username) return null;
    const dex = emptyDex();
    const source = raw.dex && typeof raw.dex === 'object' ? raw.dex : {};
    DEX_TYPES.forEach((type) => {
      if (!Array.isArray(source[type])) return;
      source[type].forEach((id) => {
        if (typeof id === 'string' && id.length > 0 && id.length <= 64) dex[type].add(id);
      });
    });
    const updated = typeof raw.updatedAt === 'string' && !isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : new Date().toISOString();
    const user = { username, updatedAt: updated, dex };
    const share = withShare ? toShare(raw.share) : null;
    if (share) user.share = share;
    return user;
  }

  function serializeUser(user, withShare) {
    const dex = {};
    DEX_TYPES.forEach((type) => { dex[type] = Array.from(user.dex[type]).sort(); });
    const data = { username: user.username, updatedAt: user.updatedAt, dex };
    if (withShare && user.share) data.share = Object.assign({}, user.share);
    return data;
  }

  function load() {
    const state = { activeUser: null, users: new Map() };
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (err) {
      raw = null;
    }
    if (raw && Array.isArray(raw.users)) {
      raw.users.forEach((item) => {
        const user = toUser(item, true);
        if (user) state.users.set(userKey(user.username), user);
      });
    }
    if (raw && state.users.has(raw.activeUser)) state.activeUser = raw.activeUser;
    else if (state.users.size) state.activeUser = state.users.keys().next().value;
    return state;
  }

  function save(state) {
    const payload = { activeUser: state.activeUser, users: Array.from(state.users.values()).map((user) => serializeUser(user, true)) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function toFileText(users) {
    return JSON.stringify({
      app: FILE_APP,
      version: FILE_VERSION,
      exportedAt: new Date().toISOString(),
      users: users.map((user) => serializeUser(user)),
    }, null, 1);
  }

  function parseFileText(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error('it is not a valid JSON file');
    }
    if (!raw || raw.app !== FILE_APP || !Array.isArray(raw.users)) {
      throw new Error('it is not a Friend Dex Tracker file');
    }
    if (typeof raw.version !== 'number' || raw.version > FILE_VERSION) {
      throw new Error('it was made by a newer version of this tracker');
    }
    const users = raw.users.map((item) => toUser(item)).filter(Boolean);
    if (!users.length) throw new Error('it does not contain any trainers');
    return users;
  }

  window.DexStore = {
    STORAGE_KEY, DEX_TYPES, MAX_NAME, SHARE_ID, OWNER_KEY,
    normalizeUsername, userKey, createUser, toUser, serializeUser, load, save, toFileText, parseFileText,
  };
})();
