'use strict';
/* Azure Table Storage and Web PubSub implementations of the stores used by shares.js. */
const { TableClient } = require('@azure/data-tables');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const { HttpError } = require('./shares');

const ROW = 'trainer';
const group = (id) => `share-${id}`;

function setting(name) {
  const value = process.env[name];
  if (!value) throw new Error(`The ${name} app setting is missing.`);
  return value;
}

// The Table service error code is in the parsed response body (or a header), not on err.code.
function tableErrorCode(err) {
  const response = err.response || {};
  const odataError = response.parsedBody && response.parsedBody.odataError;
  if (odataError && odataError.code) return odataError.code;
  const header = response.headers && typeof response.headers.get === 'function' ? response.headers.get('x-ms-error-code') : '';
  return err.code || header || '';
}

function createTableStore() {
  const table = TableClient.fromConnectionString(setting('STORAGE_CONNECTION_STRING'), process.env.TABLE_NAME || 'trainers');
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
    if (!client) client = new WebPubSubServiceClient(setting('WEBPUBSUB_CONNECTION_STRING'), process.env.PUBSUB_HUB || 'dex');
    return client;
  };
  return {
    notify: (id, message) => service().sendToGroup(group(id), message),
    async clientUrl(ids) {
      const token = await service().getClientAccessToken({ groups: ids.map(group), expirationTimeInMinutes: 120 });
      return token.url;
    },
  };
}

module.exports = { createTableStore, createPubSub };
