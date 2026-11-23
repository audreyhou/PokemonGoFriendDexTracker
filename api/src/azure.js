'use strict';
/* Azure Table Storage and Web PubSub implementations of the stores used by shares.js.
   In Azure the Function App signs in with its managed identity (STORAGE_ACCOUNT_NAME and
   WEBPUBSUB_ENDPOINT), so no account keys are stored anywhere. The *_CONNECTION_STRING settings
   are only a fallback for local development. */
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const { HttpError } = require('./shares');

const ROW = 'trainer';
const group = (id) => `share-${id}`;

function setting(name) {
  const value = process.env[name];
  if (!value) throw new Error(`The ${name} app setting is missing.`);
  return value;
}

let credential = null;
const identity = () => {
  if (!credential) credential = new DefaultAzureCredential();
  return credential;
};

// The Table service error code is in err.details / the parsed response body, not on err.code.
function tableErrorCode(err) {
  const response = err.response || {};
  const odataError = (err.details && err.details.odataError) || (response.parsedBody && response.parsedBody.odataError);
  if (odataError && odataError.code) return odataError.code;
  const header = response.headers && typeof response.headers.get === 'function' ? response.headers.get('x-ms-error-code') : '';
  return err.code || header || '';
}

function createTableStore() {
  const tableName = process.env.TABLE_NAME || 'trainers';
  const account = process.env.STORAGE_ACCOUNT_NAME;
  const table = account
    ? new TableClient(`https://${account}.table.core.windows.net`, tableName, identity())
    : TableClient.fromConnectionString(setting('STORAGE_CONNECTION_STRING'), tableName);
  const toEntity = (id, record) => ({ partitionKey: id, rowKey: ROW, ...record });
  return {
    async get(id) {
      try {
        const entity = await table.getEntity(id, ROW);
        return {
          etag: entity.etag,
          record: {
            username: entity.username, updatedAt: entity.updatedAt, ownerKeyHash: entity.ownerKeyHash, dexGz: entity.dexGz,
          },
        };
      } catch (err) {
        // A missing table (TableNotFound) is a server problem, not a turned-off link.
        if (err.statusCode === 404 && tableErrorCode(err) !== 'TableNotFound') return null;
        throw err;
      }
    },
    insert: (id, record) => table.createEntity(toEntity(id, record)),
    async replace(id, record, etag) {
      try {
        await table.updateEntity(toEntity(id, record), 'Replace', { etag });
      } catch (err) {
        if (err.statusCode === 412) throw new HttpError(409, 'the Pokédex changed at the same time; please try again');
        throw err;
      }
    },
    async remove(id) {
      try {
        await table.deleteEntity(id, ROW);
      } catch (err) {
        if (err.statusCode !== 404) throw err;
      }
    },
  };
}

function createPubSub() {
  let client = null;
  const service = () => {
    if (client) return client;
    const hub = process.env.PUBSUB_HUB || 'dex';
    const endpoint = process.env.WEBPUBSUB_ENDPOINT;
    client = endpoint
      ? new WebPubSubServiceClient(endpoint, identity(), hub)
      : new WebPubSubServiceClient(setting('WEBPUBSUB_CONNECTION_STRING'), hub);
    return client;
  };
  return {
    notify: (id, message) => service().group(group(id)).sendToAll(message),
    /* Clients connect with the json.webpubsub.azure.v1 subprotocol and join each share-<id> group
       themselves; the token only allows joining the groups of the requested links. */
    async clientUrl(ids) {
      const token = await service().getClientAccessToken({
        roles: ids.map((id) => `webpubsub.joinLeaveGroup.${group(id)}`),
        expirationTimeInMinutes: 120,
      });
      return token.url;
    },
  };
}

module.exports = { createTableStore, createPubSub };
