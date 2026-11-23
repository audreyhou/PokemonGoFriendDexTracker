'use strict';
const { app } = require('@azure/functions');
const { createShareApi, HttpError, MAX_BODY_BYTES } = require('../shares');
const { createTableStore, createPubSub } = require('../azure');
const { createRateLimiter, clientIp } = require('../rateLimit');

let services = null;
const rateLimit = createRateLimiter();
const NO_STORE = { 'Cache-Control': 'no-store' };

// Storage and Web PubSub clients are reused; the API is rebuilt per request so warnings go to that request's log.
function getApi(context) {
  if (!services) services = { store: createTableStore(), pubsub: createPubSub() };
  return createShareApi({ ...services, log: (message) => context.warn(message) });
}

async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new HttpError(413, 'the Pokédex is too large');
  return request.text();
}

async function run(request, context, rule, action) {
  const retryAfter = rateLimit(rule, clientIp(request.headers));
  if (retryAfter) {
    return {
      status: 429,
      jsonBody: { error: 'too many requests; please wait a moment and try again', code: 'rate_limited' },
      headers: { ...NO_STORE, 'Retry-After': String(retryAfter) },
    };
  }
  try {
    const result = await action(getApi(context));
    return { status: result.status, jsonBody: result.body, headers: NO_STORE };
  } catch (err) {
    if (err instanceof HttpError) {
      return { status: err.status, jsonBody: { error: err.message, code: err.code || undefined }, headers: NO_STORE };
    }
    context.error(err);
    return { status: 500, jsonBody: { error: 'the server had a problem; please try again later' }, headers: NO_STORE };
  }
}

app.http('createShare', {
  route: 'shares',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: (request, context) => run(request, context, 'create', async (shares) => shares.create(await readBody(request))),
});

app.http('share', {
  route: 'shares/{id}',
  methods: ['GET', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  handler: (request, context) => run(request, context, request.method === 'GET' ? 'read' : 'write', async (shares) => {
    const { id } = request.params;
    const authorization = request.headers.get('authorization');
    if (request.method === 'GET') return shares.get(id);
    if (request.method === 'PUT') return shares.update(id, authorization, await readBody(request));
    return shares.remove(id, authorization);
  }),
});

app.http('verifyShare', {
  route: 'shares/{id}/verify',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: (request, context) => run(request, context, 'write', (shares) => shares.verify(request.params.id, request.headers.get('authorization'))),
});

app.http('negotiate', {
  route: 'negotiate',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: (request, context) => run(request, context, 'read', (shares) => shares.negotiate(request.query.get('ids'))),
});
