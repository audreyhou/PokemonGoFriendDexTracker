/* Friend Dex Tracker UI: trainer switching, dex tabs, filtering, file import/export and share links. */
(function () {
  'use strict';

  const DATA = window.DEX_DATA;
  const Store = window.DexStore;
  const Live = window.DexLive;
  const GAMEINFO_IMG = 'https://pokemon.gameinfo.io/img';

  const TABS = {
    original: { title: 'Original Pokédex', blurb: 'Every Pokémon and costume Pokémon you have caught.' },
    shiny: { title: 'Shiny Pokédex', blurb: 'Shiny Pokémon you own.', shiny: true },
    lucky: {
      title: 'Lucky Pokédex',
      blurb: 'Lucky Pokémon you own. Mythical Pokémon that cannot be traded are not listed.',
      eligible: (e) => !e.noTrade,
    },
    xxl: { title: 'XXL Pokédex', blurb: 'Pokémon you own in XXL size.' },
    xxs: { title: 'XXS Pokédex', blurb: 'Pokémon you own in XXS size.' },
    shadow: {
      title: 'Shadow Pokédex',
      blurb: 'Shadow Pokémon you own. Only Pokémon released as Shadow Pokémon are listed.',
      eligible: (e) => !!e.shadow,
    },
    purified: {
      title: 'Purified Pokédex',
      blurb: 'Purified Pokémon you own. Only Pokémon released as Shadow Pokémon are listed.',
      eligible: (e) => !!e.shadow,
    },
    perfect: { title: '100% Pokédex', blurb: 'Pokémon you own with perfect 15/15/15 IVs.' },
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    userSelect: $('user-select'), addUser: $('add-user'), renameUser: $('rename-user'), deleteUser: $('delete-user'),
    shareUser: $('share-user'), exportUser: $('export-user'), exportAll: $('export-all'), importButton: $('import-button'), importFile: $('import-file'),
    title: $('dex-title'), blurb: $('dex-blurb'), progressCount: $('progress-count'), progressPct: $('progress-pct'),
    progressBar: $('progress-bar'), userUpdated: $('user-updated'), liveStatus: $('live-status'),
    search: $('search'), evolutionFilter: $('evolution-filter'), genFilter: $('gen-filter'), statusFilter: $('status-filter'), kindFilter: $('kind-filter'),
    unreleasedFilter: $('unreleased-filter'), welcome: $('welcome'), dex: $('dex'), dataDate: $('data-date'),
    dropOverlay: $('drop-overlay'), toast: $('toast'),
    importDialog: $('import-dialog'), importForm: $('import-form'), importList: $('import-list'),
    nameDialog: $('name-dialog'), nameForm: $('name-form'), nameTitle: $('name-title'), nameInput: $('name-input'), nameError: $('name-error'),
    shareDialog: $('share-dialog'), shareTitle: $('share-title'), shareIntro: $('share-intro'), shareLinks: $('share-links'),
    shareLink: $('share-link'), shareNative: $('share-native'), syncBlock: $('sync-block'), syncLink: $('sync-link'),
    shareError: $('share-error'), shareStop: $('share-stop'), shareClose: $('share-close'), shareCreate: $('share-create'),
  };

  const gens = DATA.gens;
  const fold = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const pad = (n) => String(n).padStart(3, '0');
  const genOf = (dex) => {
    const index = gens.findIndex(([last]) => dex <= last);
    return index < 0 ? gens.length - 1 : index;
  };
  const entries = DATA.entries.map((e) => Object.assign({}, e, {
    gen: genOf(e.dex),
    key: fold(`${e.name} #${e.dex} #${pad(e.dex)}`),
  }));
  const byId = new Map(entries.map((e) => [e.id, e]));

  // Dex number -> every dex number in its evolution families (a species can be in several,
  // e.g. Meowth is in both the Meowth -> Persian and Galarian Meowth -> Perrserker lines).
  const relativesByDex = new Map();
  DATA.families.forEach((family) => {
    family.forEach((dex) => {
      if (!relativesByDex.has(dex)) relativesByDex.set(dex, new Set());
      family.forEach((relative) => relativesByDex.get(dex).add(relative));
    });
  });

  let state = Store.load();
  const filters = { search: '', evolution: false, gen: '', status: '', kind: '', unreleased: false };
  let genCounts = [];
  let saveTimer = null;
  let toastTimer = null;
  let rangeAnchorId = null; // last clicked Pokémon; the start of a Shift+click range

  // ------------------------------------------------------------------ helpers

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function formatDate(iso) {
    // Date-only strings parse as UTC midnight, which shows the previous day in the Americas.
    const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
    return isNaN(date) ? 'unknown' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function localDateStamp() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function currentTab() {
    const tab = location.hash.slice(1);
    return Object.prototype.hasOwnProperty.call(TABS, tab) ? tab : 'original';
  }

  function activeUser() {
    return state.activeUser ? state.users.get(state.activeUser) || null : null;
  }

  // Owners created the share link in this browser (or synced it here); followers opened a friend's link.
  const isOwner = (user) => !!(user && user.share && user.share.role === 'owner');
  const isFollower = (user) => !!(user && user.share && user.share.role === 'follower');
  // 'mine' for your own trainers (and backups of them), 'friend' for friends' trainers.
  const kindOf = (user) => (isFollower(user) || (user && user.kind === 'friend') ? 'friend' : 'mine');

  function toast(message, isError) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', !!isError);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 7000 : 3500);
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      Store.save(state);
    } catch (err) {
      toast('Could not save: this browser\'s storage is full or disabled. Export a file to keep your progress.', true);
    }
    schedulePush();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 300);
  }

  /* Image candidates in order of preference. Costumes use Bulbapedia art first, everything else
     uses gameinfo art; shiny views fall back to regular art when no shiny image exists. */
  function imageSources(e, shiny) {
    const gameinfo = (suffix) => (e.gi ? [
      `${GAMEINFO_IMG}/pokemon/140/p${e.dex}f${e.gi}${suffix}.webp`,
      `${GAMEINFO_IMG}/pokemon/256/p${e.dex}f${e.gi}${suffix}.webp`,
    ] : []);
    const list = [];
    if (shiny) {
      if (e.shinyImg) list.push(e.shinyImg);
      list.push(...gameinfo('s1'));
    }
    if (e.img) list.push(e.img);
    list.push(...gameinfo(''));
    return list;
  }

  // ------------------------------------------------------------------ rendering

  function inPool(e, tab) {
    const eligible = TABS[tab].eligible;
    if (eligible && !eligible(e)) return false;
    if (!filters.unreleased && e.unreleased) return false;
    if (filters.kind === 'regular' && e.costume) return false;
    if (filters.kind === 'costume' && !e.costume) return false;
    return true;
  }

  /* With "Include evolution line", a search for a Pokémon also shows every member of its
     evolution family. Costume names are ignored here so "Pikachu" does not pull in the
     Bulbasaur line just because of Bulbasaur's Pikachu visor costume. */
  function evolutionLineDexes() {
    if (!filters.search || !filters.evolution) return null;
    const dexes = new Set();
    entries.forEach((e) => {
      if (e.costume || !e.key.includes(filters.search)) return;
      (relativesByDex.get(e.dex) || new Set([e.dex])).forEach((dex) => dexes.add(dex));
    });
    return dexes;
  }

  function isVisible(e, caught, lineDexes) {
    if (filters.gen !== '' && e.gen !== Number(filters.gen)) return false;
    if (filters.status === 'caught' && !caught.has(e.id)) return false;
    if (filters.status === 'missing' && caught.has(e.id)) return false;
    return !filters.search || e.key.includes(filters.search) || (!!lineDexes && lineDexes.has(e.dex));
  }

  function cardHtml(e, isCaught, shiny) {
    const sources = imageSources(e, shiny);
    const label = `#${pad(e.dex)} ${e.name}`;
    const details = [label];
    if (e.note) details.push(e.note);
    if (e.evoOnly) details.push('Obtained by evolving a costume Pokémon');
    if (e.unreleased) details.push('Not yet released in Pokémon GO');
    return `<button type="button" class="mon${isCaught ? ' caught' : ''}${e.costume ? ' costume' : ''}" data-id="${escapeHtml(e.id)}" aria-pressed="${isCaught}" title="${escapeHtml(details.join('\n'))}">`
      + `<img class="mon-img" src="${escapeHtml(sources[0])}" data-srcs="${escapeHtml(sources.join(' '))}" data-i="0" alt="" width="80" height="80" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      + `<span class="mon-num">#${pad(e.dex)}</span><span class="mon-name">${escapeHtml(e.name)}</span></button>`;
  }

  function render() {
    const tab = currentTab();
    const config = TABS[tab];
    const user = activeUser();
    const caught = user ? user.dex[tab] : new Set();

    document.body.dataset.tab = tab;
    document.title = `${config.title} · Friend Dex Tracker`;
    document.querySelectorAll('.tabs a').forEach((link) => {
      if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    els.title.textContent = user ? `${user.username}'s ${config.title}` : config.title;
    els.blurb.textContent = config.blurb;
    els.welcome.hidden = !!user;

    genCounts = gens.map(() => ({ caught: 0, total: 0 }));
    rangeAnchorId = null;
    const lineDexes = evolutionLineDexes();
    const html = [];
    let openGen = -1;
    entries.forEach((e) => {
      if (!inPool(e, tab)) return;
      const has = caught.has(e.id);
      genCounts[e.gen].total += 1;
      if (has) genCounts[e.gen].caught += 1;
      if (!isVisible(e, caught, lineDexes)) return;
      if (e.gen !== openGen) {
        if (openGen >= 0) html.push('</div></section>');
        openGen = e.gen;
        html.push(`<section class="gen"><h3>Gen ${e.gen + 1} · ${escapeHtml(gens[e.gen][1])} <span class="gen-count" data-gen="${e.gen}"></span></h3><div class="grid">`);
      }
      html.push(cardHtml(e, has, !!config.shiny));
    });
    if (openGen >= 0) html.push('</div></section>');
    els.dex.innerHTML = html.length ? html.join('') : '<p class="empty">No Pokémon match these filters.</p>';
    updateProgress();
  }

  function updateProgress() {
    const total = genCounts.reduce((sum, g) => sum + g.total, 0);
    const caught = genCounts.reduce((sum, g) => sum + g.caught, 0);
    const pct = total ? Math.floor((caught / total) * 1000) / 10 : 0;
    els.progressCount.textContent = `${caught.toLocaleString()} / ${total.toLocaleString()}`;
    els.progressPct.textContent = `${pct}%`;
    els.progressBar.style.width = `${pct}%`;
    els.progressBar.parentElement.setAttribute('aria-valuenow', String(pct));
    els.dex.querySelectorAll('.gen-count').forEach((span) => {
      const counts = genCounts[Number(span.dataset.gen)];
      span.textContent = `${counts.caught} / ${counts.total}`;
    });
    const user = activeUser();
    els.userUpdated.textContent = user
      ? `${kindOf(user) === 'mine' ? 'Your trainer' : 'Friend'} · last updated ${formatDate(user.updatedAt)}`
      : '';
    updateLiveStatus();
  }

  function renderUsers() {
    const users = Array.from(state.users.entries()).sort((a, b) => a[1].username.localeCompare(b[1].username));
    els.userSelect.innerHTML = '';
    if (!users.length) els.userSelect.add(new Option('No trainers yet', ''));
    const option = ([key, user]) => {
      let label = user.username;
      if (isOwner(user)) label += ' · shared';
      else if (isFollower(user)) label += ' · live link';
      return new Option(label, key);
    };
    const friends = users.filter(([, user]) => kindOf(user) === 'friend');
    if (friends.length) {
      [['My trainers', users.filter(([, user]) => kindOf(user) === 'mine')], ['Friends', friends]].forEach(([label, list]) => {
        if (!list.length) return;
        const group = document.createElement('optgroup');
        group.label = label;
        list.forEach((item) => group.appendChild(option(item)));
        els.userSelect.appendChild(group);
      });
    } else {
      users.forEach((item) => els.userSelect.add(option(item)));
    }
    els.userSelect.value = state.activeUser || '';
    const user = activeUser();
    const hasUser = !!user;
    els.userSelect.disabled = !users.length;
    els.renameUser.disabled = !hasUser || isFollower(user);
    els.deleteUser.disabled = !hasUser;
    els.deleteUser.textContent = isFollower(user) ? 'Remove' : 'Delete';
    els.shareUser.hidden = !Live.enabled;
    els.shareUser.disabled = !hasUser;
    els.exportUser.disabled = !hasUser;
    els.exportAll.disabled = users.length < 2;
    document.body.classList.toggle('read-only', isFollower(user));
  }

  function refresh() {
    renderUsers();
    render();
    updateWatch();
  }

  function selectUser(key) {
    if (saveTimer) persist();
    state.activeUser = key;
    persist();
    refresh();
  }

  // ------------------------------------------------------------------ trainers

  function askName(title, initial, currentKey) {
    return new Promise((resolve) => {
      const dialog = els.nameDialog;
      els.nameTitle.textContent = title;
      els.nameInput.value = initial || '';
      els.nameError.hidden = true;

      const onSubmit = (event) => {
        const name = Store.normalizeUsername(els.nameInput.value);
        const key = Store.userKey(name);
        let error = '';
        if (!name) error = 'Please enter a username.';
        else if (state.users.has(key) && key !== currentKey) error = `A trainer named “${state.users.get(key).username}” already exists.`;
        if (error) {
          event.preventDefault();
          els.nameError.textContent = error;
          els.nameError.hidden = false;
        }
      };
      const onClose = () => {
        els.nameForm.removeEventListener('submit', onSubmit);
        dialog.removeEventListener('close', onClose);
        resolve(dialog.returnValue === 'ok' ? Store.normalizeUsername(els.nameInput.value) : null);
      };
      els.nameForm.addEventListener('submit', onSubmit);
      dialog.addEventListener('close', onClose);
      dialog.returnValue = '';
      dialog.showModal();
      els.nameInput.select();
    });
  }

  async function addUser() {
    const name = await askName('New trainer', '');
    if (!name) return;
    const key = Store.userKey(name);
    state.users.set(key, Store.createUser(name));
    state.activeUser = key;
    persist();
    refresh();
    toast(`Added ${name}. Tap Pokémon to check them off.`);
  }

  async function renameUser() {
    const user = activeUser();
    if (!user || isFollower(user)) return;
    const oldKey = state.activeUser;
    const name = await askName('Rename trainer', user.username, oldKey);
    if (!name || name === user.username) return;
    const key = Store.userKey(name);
    state.users.delete(oldKey);
    user.username = name;
    user.updatedAt = new Date().toISOString();
    state.users.set(key, user);
    state.activeUser = key;
    persist();
    refresh();
  }

  function deleteUser() {
    const user = activeUser();
    if (!user) return;
    let question = `Delete ${user.username}'s Pokédex from this browser?\n\nExport a file first if you want to keep a copy.`;
    if (isFollower(user)) {
      question = `Remove ${user.username} from this browser?\n\nOnly your copy is removed. ${user.username}'s own Pokédex and share link are not affected, `
        + 'and you can add them again by opening their link.';
    } else if (isOwner(user)) {
      question += `\n\n${user.username}'s share link keeps working with the last saved Pokédex. To turn it off, use Share link → Stop sharing first. `
        + 'If no other browser is synced, the link can no longer be changed after this.';
    }
    if (!confirm(question)) return;
    state.users.delete(state.activeUser);
    state.activeUser = state.users.size ? state.users.keys().next().value : null;
    persist();
    refresh();
    toast(`Deleted ${user.username}.`);
  }

  // ------------------------------------------------------------------ files

  function slug(text) {
    return fold(text).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'trainer';
  }

  function download(fileName, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportUser() {
    const user = activeUser();
    if (!user) return;
    if (saveTimer) persist();
    download(`friend-dex-${slug(user.username)}-${localDateStamp()}.json`, Store.toFileText([user]));
    toast(`Exported ${user.username}'s file. Send it to a friend so they can import it.`);
  }

  function exportAll() {
    const users = Array.from(state.users.values()).sort((a, b) => a.username.localeCompare(b.username));
    if (!users.length) return;
    download(`friend-dex-all-trainers-${localDateStamp()}.json`, Store.toFileText(users));
    toast(`Exported ${users.length} trainers.`);
  }

  /* Asks whether each imported trainer is the user's own (a backup) or a friend's. Resolves with
     one kind per trainer, or null when cancelled. */
  function askImportKinds(found) {
    return new Promise((resolve) => {
      const dialog = els.importDialog;
      els.importList.innerHTML = found.map(({ user }, i) => {
        const existing = state.users.get(Store.userKey(user.username));
        const preset = existing ? kindOf(existing) : '';
        const radio = (value, label) => `<label class="check"><input type="radio" name="kind-${i}" value="${value}" required`
          + `${preset === value ? ' checked' : ''}> ${label}</label>`;
        return `<fieldset class="import-row"><legend>${escapeHtml(user.username)}`
          + ` <span class="muted small">· last updated ${escapeHtml(formatDate(user.updatedAt))}</span></legend>`
          + `${radio('mine', 'Mine (backup)')}${radio('friend', 'A friend\'s')}</fieldset>`;
      }).join('');
      const onClose = () => {
        dialog.removeEventListener('close', onClose);
        resolve(dialog.returnValue === 'ok' ? found.map((item, i) => els.importForm.elements[`kind-${i}`].value) : null);
      };
      dialog.addEventListener('close', onClose);
      dialog.returnValue = '';
      dialog.showModal();
    });
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (saveTimer) persist();
    const imported = [];
    const problems = [];
    const found = [];
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) {
        problems.push(`${file.name}: the file is too large`);
        continue;
      }
      let users;
      try {
        users = Store.parseFileText(await file.text());
      } catch (err) {
        problems.push(`${file.name}: ${err.message}`);
        continue;
      }
      users.forEach((user) => found.push({ user, fileName: file.name }));
    }
    els.importFile.value = '';
    const kinds = found.length ? await askImportKinds(found) : null;
    if (kinds) {
      found.forEach(({ user, fileName }, i) => {
        const key = Store.userKey(user.username);
        const existing = state.users.get(key);
        if (existing && !confirm(
          `Replace the saved Pokédex for “${existing.username}” with the one from ${fileName}?\n\n`
          + `Saved here: last updated ${formatDate(existing.updatedAt)}\nIn the file: last updated ${formatDate(user.updatedAt)}`,
        )) return;
        user.kind = kinds[i];
        // Restoring a backup of a trainer you share keeps its link working.
        if (isOwner(existing)) {
          user.share = existing.share;
          user.kind = 'mine';
        }
        state.users.set(key, user);
        imported.push(user.username);
      });
    }
    if (imported.length) {
      state.activeUser = Store.userKey(imported[imported.length - 1]);
      persist();
      refresh();
    }
    if (problems.length) toast(`Could not import ${problems.join('; ')}.`, true);
    else if (imported.length) toast(`Imported ${imported.join(', ')}.`);
    else toast('Nothing was imported.');
  }

  // ------------------------------------------------------------------ share links

  const LINK_HASH = /^#(follow|sync)=([A-Za-z0-9_-]{12})(?:\.([A-Za-z0-9_-]{20,200}))?$/;
  const ownerStatus = new Map(); // share id -> 'saving' | 'synced' | 'offline'
  const pulling = new Set();
  const pullAgain = new Set();
  let pushTimer = null;
  let pushing = false;
  let pushAgain = false;
  let pushRetryMs = 0;
  const watcher = Live.enabled ? Live.createWatcher((id) => pullShare(id)) : null;

  const needsPush = (user) => isOwner(user) && user.share.syncedAt !== user.updatedAt;
  // Only these API answers mean the link is really gone; other 403/404s can come from Azure itself.
  const linkGone = (err) => err.code === 'share_not_found' || err.code === 'bad_owner_key';
  const linkUrl = (hash) => `${location.origin}${location.pathname}#${hash}`;

  function findShare(id) {
    for (const entry of state.users) {
      if (entry[1].share && entry[1].share.id === id) return entry;
    }
    return null;
  }

  // Followers watch for the owner's changes; owners watch for changes made in their other synced browsers.
  function updateWatch() {
    if (watcher) watcher.watch(Array.from(state.users.values()).filter((user) => user.share).map((user) => user.share.id));
  }

  function updateLiveStatus() {
    const user = activeUser();
    if (!user || !user.share) {
      els.liveStatus.hidden = true;
      return;
    }
    let status = 'live';
    let text = `Shared by ${user.username} · updates automatically`;
    if (isOwner(user)) {
      status = ownerStatus.get(user.share.id) || (needsPush(user) ? 'saving' : 'synced');
      if (status === 'synced' && needsPush(user)) status = 'saving';
      text = {
        synced: 'Shared by link · friends see your changes',
        saving: 'Shared by link · sharing changes…',
        offline: 'Shared by link · offline, changes will be shared when you reconnect',
      }[status];
    }
    els.liveStatus.textContent = text;
    els.liveStatus.dataset.status = status;
    els.liveStatus.hidden = false;
  }

  function schedulePush(delay) {
    if (!Live.enabled) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushChanges, delay === undefined ? 1500 : delay);
  }

  /* Sends changes of trainers this browser owns to the share server. */
  async function pushChanges(keepalive) {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (pushing) {
      pushAgain = true;
      return;
    }
    const pending = Array.from(state.users.values()).filter(needsPush);
    if (!pending.length) return;
    pushing = true;
    let offline = false;
    for (const user of pending) {
      const { id, ownerKey } = user.share;
      const sentAt = user.updatedAt;
      ownerStatus.set(id, 'saving');
      updateLiveStatus();
      try {
        await Live.api.update(id, ownerKey, Store.serializeUser(user), keepalive === true);
        const linked = findShare(id);
        if (linked && isOwner(linked[1])) linked[1].share.syncedAt = sentAt;
        ownerStatus.set(id, 'synced');
      } catch (err) {
        if (err.status === 409) {
          ownerStatus.set(id, 'synced');
          pullShare(id, true);
        } else if (linkGone(err)) {
          shareEnded(id);
        } else {
          ownerStatus.set(id, 'offline');
          offline = true;
        }
      }
    }
    pushing = false;
    persist();
    if (pushAgain) {
      pushAgain = false;
      schedulePush(0);
    } else if (offline) {
      pushRetryMs = Math.min(pushRetryMs ? pushRetryMs * 2 : 15000, 5 * 60 * 1000);
      schedulePush(pushRetryMs);
    } else {
      pushRetryMs = 0;
    }
    updateLiveStatus();
  }

  /* Downloads the latest version of a shared trainer. Owners only take it when it is newer than
     their own copy (changed in another synced browser), unless force is set after a conflict. */
  async function pullShare(id, force) {
    if (pulling.has(id)) {
      pullAgain.add(id);
      return;
    }
    pulling.add(id);
    try {
      applyRemote(id, await Live.api.get(id), force);
    } catch (err) {
      if (linkGone(err)) shareEnded(id);
    } finally {
      pulling.delete(id);
      if (pullAgain.delete(id)) pullShare(id, force);
    }
  }

  function pullAll() {
    if (!Live.enabled) return;
    Array.from(state.users.values()).forEach((user) => { if (user.share) pullShare(user.share.id); });
  }

  function applyRemote(id, data, force) {
    const linked = findShare(id);
    const incoming = Store.toUser(data);
    if (!linked || !incoming) return;
    const [key, user] = linked;
    if (isOwner(user)) {
      if (!force && (needsPush(user) || !(Date.parse(incoming.updatedAt) > Date.parse(user.updatedAt)))) return;
      user.share.syncedAt = incoming.updatedAt;
    } else if (incoming.updatedAt === user.updatedAt && incoming.username === user.username) {
      return;
    }
    user.dex = incoming.dex;
    user.updatedAt = incoming.updatedAt;
    let newKey = key;
    const renamedKey = Store.userKey(incoming.username);
    if (renamedKey === key || !state.users.has(renamedKey)) {
      user.username = incoming.username;
      newKey = renamedKey;
    }
    if (newKey !== key) {
      state.users.delete(key);
      state.users.set(newKey, user);
      if (state.activeUser === key) state.activeUser = newKey;
    }
    persist();
    if (state.activeUser === newKey) refresh();
    else renderUsers();
    if (force) toast(`${user.username} was changed in another browser, so this browser now shows the newest version.`);
  }

  function shareEnded(id) {
    const linked = findShare(id);
    if (!linked) return;
    const user = linked[1];
    const wasOwner = isOwner(user);
    delete user.share;
    ownerStatus.delete(id);
    persist();
    refresh();
    toast(wasOwner
      ? `${user.username}'s share link was turned off, so changes here are no longer shared.`
      : `${user.username} turned off their share link. Their last Pokédex is kept here.`, true);
  }

  /* Adds a trainer from a share or sync link, asking before it replaces a trainer with the same name. */
  function placeLinkedUser(user, linked) {
    const key = Store.userKey(user.username);
    const existing = state.users.get(key);
    if (existing && (!linked || existing !== linked[1])) {
      if (isOwner(existing)) {
        toast(`You already have a shared trainer named “${existing.username}”. Rename it, then open the link again.`, true);
        return false;
      }
      if (!confirm(
        `Replace the saved Pokédex for “${existing.username}” with the one from this link?\n\n`
        + `Saved here: last updated ${formatDate(existing.updatedAt)}\nFrom the link: last updated ${formatDate(user.updatedAt)}`,
      )) return false;
    }
    if (linked) state.users.delete(linked[0]);
    state.users.set(key, user);
    selectUser(key);
    return true;
  }

  async function followShare(id) {
    const linked = findShare(id);
    if (linked && isOwner(linked[1])) {
      selectUser(linked[0]);
      toast(`That is the share link for your own trainer, ${linked[1].username}.`);
      return;
    }
    let data;
    try {
      data = await Live.api.get(id);
    } catch (err) {
      toast(err.code === 'share_not_found' ? 'This share link was turned off or does not exist.' : `Could not open the share link: ${err.message}.`, true);
      return;
    }
    const user = Store.toUser(data);
    if (!user) {
      toast('This share link does not contain a trainer.', true);
      return;
    }
    user.share = { id, role: 'follower' };
    user.kind = 'friend';
    if (placeLinkedUser(user, findShare(id))) toast(`Added ${user.username}. Their Pokédex updates here automatically.`);
  }

  async function syncShare(id, ownerKey) {
    const linked = findShare(id);
    if (linked && isOwner(linked[1])) {
      selectUser(linked[0]);
      toast(`${linked[1].username} is already synced with this browser.`);
      return;
    }
    let data;
    try {
      data = await Live.api.verify(id, ownerKey);
    } catch (err) {
      let message = `Could not sync: ${err.message}.`;
      if (err.code === 'bad_owner_key') message = 'This sync link is not valid.';
      else if (err.code === 'share_not_found') message = 'This trainer\'s share link was turned off, so it cannot be synced.';
      toast(message, true);
      return;
    }
    const user = Store.toUser(data);
    if (!user) return;
    user.share = { id, role: 'owner', ownerKey, syncedAt: user.updatedAt };
    user.kind = 'mine';
    if (placeLinkedUser(user, findShare(id))) toast(`${user.username} is now synced with this browser. Changes you make here are shared too.`);
  }

  /* Handles #follow=<id> (a friend's share link) and #sync=<id>.<key> (your private sync link). */
  function openLinkFromHash() {
    const match = LINK_HASH.exec(location.hash);
    if (!match) return false;
    history.replaceState(null, '', location.pathname + location.search);
    render();
    if (!Live.enabled) toast('Share links are not available on this copy of the tracker.', true);
    else if (match[1] === 'follow') followShare(match[2]);
    else if (match[3]) syncShare(match[2], match[3]);
    return true;
  }

  function showShareError(message) {
    els.shareError.textContent = message;
    els.shareError.hidden = !message;
  }

  function showShareDialog() {
    const user = activeUser();
    if (!user) return;
    if (saveTimer) persist();
    showShareError('');
    const { share } = user;
    els.shareTitle.textContent = `Share ${user.username}`;
    const canCreate = !share && kindOf(user) === 'mine';
    if (!share && !canCreate) {
      els.shareIntro.textContent = `${user.username} was imported as a friend's trainer. Only your own trainers can be shared by link; `
        + `ask ${user.username} to send you their share link instead.`;
    } else if (!share) {
      els.shareIntro.textContent = `Create a link that adds ${user.username} to a friend's tracker when they open it. `
        + 'Their copy updates automatically whenever you check off Pokémon here. Anyone with the link can view this Pokédex.';
    } else if (isOwner(user)) {
      els.shareIntro.textContent = `Send this link to friends. Opening it adds ${user.username} to their tracker, and their copy `
        + 'updates automatically when you make changes.';
    } else {
      els.shareIntro.textContent = `This is ${user.username}'s share link. Anyone who opens it can add ${user.username} to their tracker.`;
    }
    els.shareLinks.hidden = !share;
    els.shareLink.value = share ? linkUrl(`follow=${share.id}`) : '';
    els.shareNative.hidden = !share || typeof navigator.share !== 'function';
    els.syncBlock.hidden = !isOwner(user);
    els.syncBlock.open = false;
    els.syncLink.value = isOwner(user) ? linkUrl(`sync=${share.id}.${share.ownerKey}`) : '';
    els.shareStop.hidden = !isOwner(user);
    els.shareCreate.hidden = !canCreate;
    if (!els.shareDialog.open) els.shareDialog.showModal();
  }

  async function createShare() {
    const user = activeUser();
    if (!user || user.share || kindOf(user) !== 'mine') return;
    els.shareCreate.disabled = true;
    showShareError('');
    const sentAt = user.updatedAt;
    try {
      const created = await Live.api.create(Store.serializeUser(user));
      user.share = { id: created.id, role: 'owner', ownerKey: created.ownerKey, syncedAt: sentAt };
      ownerStatus.set(created.id, 'synced');
      persist();
      refresh();
      showShareDialog();
    } catch (err) {
      showShareError(`Could not create the link: ${err.message}.`);
    } finally {
      els.shareCreate.disabled = false;
    }
  }

  async function stopSharing() {
    const user = activeUser();
    if (!isOwner(user)) return;
    if (!confirm(`Turn off ${user.username}'s share link?\n\nFriends keep their last copy but stop getting updates, and sync links `
      + 'for your other browsers stop working. You can create a new link at any time.')) return;
    const { id, ownerKey } = user.share;
    els.shareStop.disabled = true;
    try {
      await Live.api.remove(id, ownerKey);
    } catch (err) {
      if (!linkGone(err)) {
        showShareError(`Could not turn off the link: ${err.message}.`);
        return;
      }
    } finally {
      els.shareStop.disabled = false;
    }
    // A push or live message may already have noticed the link is gone while the request ran.
    ownerStatus.delete(id);
    if (user.share && user.share.id === id) delete user.share;
    persist();
    refresh();
    els.shareDialog.close();
    toast(`Turned off ${user.username}'s share link.`);
  }

  async function copyLink(button) {
    const input = $(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (err) {
      input.select();
      document.execCommand('copy');
    }
    button.textContent = 'Copied!';
    setTimeout(() => { button.textContent = 'Copy'; }, 2000);
  }

  // ------------------------------------------------------------------ events

  function setCaught(set, button, caught) {
    const id = button.dataset.id;
    if (set.has(id) === caught) return;
    if (caught) set.add(id);
    else set.delete(id);
    button.classList.toggle('caught', caught);
    button.setAttribute('aria-pressed', String(caught));
    genCounts[byId.get(id).gen].caught += caught ? 1 : -1;
  }

  // Shift+click would otherwise also select the page text between the two clicks.
  els.dex.addEventListener('mousedown', (event) => {
    if (event.shiftKey && event.target.closest('button.mon')) event.preventDefault();
  });

  /* Click toggles one Pokémon. Shift+click gives every card shown between the previously
     clicked card and this one the same state as the previously clicked card, so a range can be
     checked or unchecked in one go. */
  els.dex.addEventListener('click', (event) => {
    const button = event.target.closest('button.mon');
    if (!button) return;
    const user = activeUser();
    if (!user) {
      addUser();
      return;
    }
    if (isFollower(user)) {
      toast(`${user.username}'s Pokédex comes from their share link, so only ${user.username} can change it.`);
      return;
    }
    const set = user.dex[currentTab()];
    const anchor = event.shiftKey && rangeAnchorId && rangeAnchorId !== button.dataset.id
      ? els.dex.querySelector(`button.mon[data-id="${CSS.escape(rangeAnchorId)}"]`)
      : null;
    if (anchor) {
      const buttons = Array.from(els.dex.querySelectorAll('button.mon'));
      const [from, to] = [buttons.indexOf(anchor), buttons.indexOf(button)].sort((a, b) => a - b);
      const caught = set.has(rangeAnchorId);
      const range = buttons.slice(from, to + 1);
      range.forEach((b) => setCaught(set, b, caught));
      toast(`${caught ? 'Checked' : 'Unchecked'} ${range.length} Pokémon.`);
    } else {
      setCaught(set, button, !set.has(button.dataset.id));
    }
    rangeAnchorId = button.dataset.id;
    user.updatedAt = new Date().toISOString();
    updateProgress();
    scheduleSave();
  });

  // Errors on <img> do not bubble, so listen in the capture phase to walk the fallback list.
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('mon-img')) return;
    const sources = img.dataset.srcs.split(' ');
    const next = Number(img.dataset.i) + 1;
    if (next < sources.length) {
      img.dataset.i = String(next);
      img.src = sources[next];
    } else {
      img.classList.add('missing');
    }
  }, true);

  els.userSelect.addEventListener('change', () => selectUser(els.userSelect.value || null));
  els.addUser.addEventListener('click', addUser);
  els.renameUser.addEventListener('click', renameUser);
  els.deleteUser.addEventListener('click', deleteUser);
  els.shareUser.addEventListener('click', showShareDialog);
  els.shareCreate.addEventListener('click', createShare);
  els.shareStop.addEventListener('click', stopSharing);
  els.shareClose.addEventListener('click', () => els.shareDialog.close());
  els.shareNative.addEventListener('click', () => {
    const user = activeUser();
    if (!user) return;
    navigator.share({ title: `${user.username}'s Pokédex`, text: `Add ${user.username} to your Friend Dex Tracker:`, url: els.shareLink.value })
      .catch(() => {});
  });
  els.shareDialog.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy]');
    if (button) copyLink(button);
  });
  els.exportUser.addEventListener('click', exportUser);
  els.exportAll.addEventListener('click', exportAll);
  els.importButton.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', () => importFiles(els.importFile.files));
  $('name-cancel').addEventListener('click', () => els.nameDialog.close('cancel'));
  $('import-cancel').addEventListener('click', () => els.importDialog.close('cancel'));
  els.welcome.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'add-user') addUser();
    else els.importFile.click();
  });

  let searchTimer = null;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filters.search = fold(els.search.value.trim());
      render();
    }, 150);
  });
  els.evolutionFilter.addEventListener('change', () => { filters.evolution = els.evolutionFilter.checked; render(); });
  els.genFilter.addEventListener('change', () => { filters.gen = els.genFilter.value; render(); });
  els.statusFilter.addEventListener('change', () => { filters.status = els.statusFilter.value; render(); });
  els.kindFilter.addEventListener('change', () => { filters.kind = els.kindFilter.value; render(); });
  els.unreleasedFilter.addEventListener('change', () => { filters.unreleased = els.unreleasedFilter.checked; render(); });
  window.addEventListener('hashchange', () => { if (!openLinkFromHash()) render(); });

  let dragDepth = 0;
  const hasFiles = (event) => !!event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    dragDepth += 1;
    els.dropOverlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropOverlay.hidden = true;
  });
  window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    importFiles(event.dataTransfer.files);
  });

  // Keep several open tabs of the tracker in sync.
  window.addEventListener('storage', (event) => {
    if (event.key !== Store.STORAGE_KEY || saveTimer) return;
    state = Store.load();
    refresh();
  });
  // Leaving the page: save, and send unshared changes right away instead of after the usual delay.
  function flushOnLeave() {
    if (saveTimer) persist();
    if (Live.enabled && Array.from(state.users.values()).some(needsPush)) pushChanges(true);
  }
  window.addEventListener('pagehide', flushOnLeave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushOnLeave();
      if (watcher) watcher.pause();
    } else if (watcher) {
      watcher.resume();
      pullAll();
    }
  });
  window.addEventListener('online', () => schedulePush(0));

  // ------------------------------------------------------------------ start

  gens.forEach(([, name], index) => els.genFilter.add(new Option(`Gen ${index + 1} · ${name}`, String(index))));
  els.dataDate.textContent = formatDate(DATA.generatedAt);
  refresh();
  pullAll();
  schedulePush(0);
  openLinkFromHash();
})();
