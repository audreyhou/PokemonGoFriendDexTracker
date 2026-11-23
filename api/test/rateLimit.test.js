'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, clientIp } = require('../src/rateLimit');

test('each client gets its own limit, which resets after the window', () => {
  let time = 0;
  const check = createRateLimiter({ create: { max: 2, windowMs: 1000 } }, () => time);
  assert.equal(check('create', 'a'), 0);
  assert.equal(check('create', 'a'), 0);
  assert.equal(check('create', 'a'), 1);
  assert.equal(check('create', 'b'), 0);
  time = 1000;
  assert.equal(check('create', 'a'), 0);
});

test('the client address is the last X-Forwarded-For entry, without its port', () => {
  const headers = (value) => new Map([['x-forwarded-for', value]]);
  assert.equal(clientIp(headers('1.1.1.1, 203.0.113.9:50123')), '203.0.113.9');
  assert.equal(clientIp(headers('[2001:db8::1]:443')), '2001:db8::1');
  assert.equal(clientIp(new Map()), 'unknown');
});
