/* Friend Dex Tracker UI: trainer switching, dex tabs, filtering, and file import/export. */
(function () {
  'use strict';

  const DATA = window.DEX_DATA;
  const Store = window.DexStore;
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
    exportUser: $('export-user'), exportAll: $('export-all'), importButton: $('import-button'), importFile: $('import-file'),
    title: $('dex-title'), blurb: $('dex-blurb'), progressCount: $('progress-count'), progressPct: $('progress-pct'),
    progressBar: $('progress-bar'), userUpdated: $('user-updated'),
    search: $('search'), evolutionFilter: $('evolution-filter'), genFilter: $('gen-filter'), statusFilter: $('status-filter'), kindFilter: $('kind-filter'),
    unreleasedFilter: $('unreleased-filter'), welcome: $('welcome'), dex: $('dex'), dataDate: $('data-date'),
    dropOverlay: $('drop-overlay'), toast: $('toast'),
    nameDialog: $('name-dialog'), nameForm: $('name-form'), nameTitle: $('name-title'), nameInput: $('name-input'), nameError: $('name-error'),
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
    els.userUpdated.textContent = user ? `${user.username} · last updated ${formatDate(user.updatedAt)}` : '';
  }

  function renderUsers() {
    const users = Array.from(state.users.entries()).sort((a, b) => a[1].username.localeCompare(b[1].username));
    els.userSelect.innerHTML = '';
    if (!users.length) els.userSelect.add(new Option('No trainers yet', ''));
    users.forEach(([key, user]) => els.userSelect.add(new Option(user.username, key)));
    els.userSelect.value = state.activeUser || '';
    const hasUser = !!activeUser();
    els.userSelect.disabled = !users.length;
    els.renameUser.disabled = !hasUser;
    els.deleteUser.disabled = !hasUser;
    els.exportUser.disabled = !hasUser;
    els.exportAll.disabled = users.length < 2;
  }

  function refresh() {
    renderUsers();
    render();
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
    if (!user) return;
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
    if (!confirm(`Delete ${user.username}'s Pokédex from this browser?\n\nExport a file first if you want to keep a copy.`)) return;
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

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (saveTimer) persist();
    const imported = [];
    const problems = [];
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
      users.forEach((user) => {
        const key = Store.userKey(user.username);
        const existing = state.users.get(key);
        if (existing && !confirm(
          `Replace the saved Pokédex for “${existing.username}” with the one from ${file.name}?\n\n`
          + `Saved here: last updated ${formatDate(existing.updatedAt)}\nIn the file: last updated ${formatDate(user.updatedAt)}`,
        )) return;
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
    els.importFile.value = '';
  }

  // ------------------------------------------------------------------ events

  els.dex.addEventListener('click', (event) => {
    const button = event.target.closest('button.mon');
    if (!button) return;
    const user = activeUser();
    if (!user) {
      addUser();
      return;
    }
    const set = user.dex[currentTab()];
    const id = button.dataset.id;
    const nowCaught = !set.has(id);
    if (nowCaught) set.add(id);
    else set.delete(id);
    button.classList.toggle('caught', nowCaught);
    button.setAttribute('aria-pressed', String(nowCaught));
    genCounts[byId.get(id).gen].caught += nowCaught ? 1 : -1;
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

  els.userSelect.addEventListener('change', () => {
    if (saveTimer) persist();
    state.activeUser = els.userSelect.value || null;
    persist();
    refresh();
  });
  els.addUser.addEventListener('click', addUser);
  els.renameUser.addEventListener('click', renameUser);
  els.deleteUser.addEventListener('click', deleteUser);
  els.exportUser.addEventListener('click', exportUser);
  els.exportAll.addEventListener('click', exportAll);
  els.importButton.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', () => importFiles(els.importFile.files));
  $('name-cancel').addEventListener('click', () => els.nameDialog.close('cancel'));
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
  window.addEventListener('hashchange', render);

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
  window.addEventListener('pagehide', () => { if (saveTimer) persist(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) persist(); });

  // ------------------------------------------------------------------ start

  gens.forEach(([, name], index) => els.genFilter.add(new Option(`Gen ${index + 1} · ${name}`, String(index))));
  els.dataDate.textContent = formatDate(DATA.generatedAt);
  refresh();
})();
