/* Live share links: calls to the share API and a WebSocket that announces changes to followed trainers. */
(function () {
  'use strict';

  const API = ((window.DEX_CONFIG && window.DEX_CONFIG.apiBase) || '').replace(/\/+$/, '');
  const POLL_MS = 60 * 1000;

  class ApiError extends Error {
    constructor(status, message, code) {
      super(message);
      this.status = status;
      this.code = code || '';
    }
  }

  async function request(method, path, options) {
    const { body, key, keepalive } = options || {};
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers.Authorization = `Bearer ${key}`;
    let response;
    try {
      response = await fetch(API + path, {
        method, headers, cache: 'no-store', keepalive: !!keepalive, body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(0, 'the share server could not be reached');
    }
    let data = null;
    try {
      data = response.status === 204 ? null : await response.json();
    } catch (err) {
      data = null;
    }
    if (!response.ok) {
      throw new ApiError(response.status, (data && data.error) || `the share server returned error ${response.status}`, data && data.code);
    }
    return data;
  }

  const path = (id) => `/shares/${encodeURIComponent(id)}`;
  const api = {
    create: (trainer) => request('POST', '/shares', { body: { trainer } }),
    get: (id) => request('GET', path(id)),
    verify: (id, key) => request('POST', `${path(id)}/verify`, { key }),
    update: (id, key, trainer, keepalive) => request('PUT', path(id), { body: { trainer }, key, keepalive }),
    remove: (id, key) => request('DELETE', path(id), { key }),
    negotiate: (ids) => request('GET', `/negotiate?ids=${ids.map(encodeURIComponent).join(',')}`),
  };

  /* Calls onChange(id) whenever a watched share changes. Uses Web PubSub when it is available and
     falls back to checking every minute. Disconnects while the page is hidden. */
  function createWatcher(onChange) {
    let ids = [];
    let paused = document.visibilityState === 'hidden';
    let socket = null;
    let pollTimer = null;
    let retryTimer = null;
    let retries = 0;
    let generation = 0;

    function stop() {
      generation += 1;
      clearTimeout(retryTimer);
      clearInterval(pollTimer);
      pollTimer = null;
      if (socket) {
        socket.onclose = null;
        socket.close();
        socket = null;
      }
    }

    function retryLater(gen) {
      if (gen !== generation) return;
      if (!pollTimer) pollTimer = setInterval(() => ids.forEach((id) => onChange(id)), POLL_MS);
      retries += 1;
      retryTimer = setTimeout(() => connect(gen), Math.min(5 * 60 * 1000, 5000 * 2 ** Math.min(retries, 6)));
    }

    async function connect(gen) {
      if (gen !== generation || !ids.length || paused) return;
      let url;
      try {
        url = (await api.negotiate(ids)).url;
      } catch (err) {
        retryLater(gen);
        return;
      }
      if (gen !== generation) return;
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () => {
        retries = 0;
        clearInterval(pollTimer);
        pollTimer = null;
        // Web PubSub does not keep messages for disconnected clients, so catch up on anything missed.
        ids.forEach((id) => onChange(id));
      };
      ws.onmessage = (event) => {
        let message = null;
        try {
          message = JSON.parse(event.data);
        } catch (err) {
          return;
        }
        if (message && typeof message.id === 'string' && ids.includes(message.id)) onChange(message.id);
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
        retryLater(gen);
      };
    }

    function restart() {
      stop();
      connect(generation);
    }

    return {
      watch(nextIds) {
        const next = Array.from(new Set(nextIds)).sort();
        if (next.join() === ids.join()) return;
        ids = next;
        restart();
      },
      pause() {
        paused = true;
        stop();
      },
      resume() {
        if (!paused) return;
        paused = false;
        restart();
      },
    };
  }

  window.DexLive = { enabled: !!API && typeof fetch === 'function', ApiError, api, createWatcher };
})();
