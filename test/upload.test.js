'use strict';

/**
 * Direct photo upload (§7.2 “add photos”): magic-byte validation, the 8 MB
 * cap, and the served-path contract the wizard writes back into its form.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs').promises;
const path = require('path');

const upload = require('../src/lib/upload');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');

test('photo upload stores by content hash and serves from /uploads/photos/', async () => {
  const result = await upload.storePhoto(PNG, 9);
  assert.equal(result.ok, true);
  assert.match(result.url, /^\/uploads\/photos\/u9\/[0-9a-f]{20}\.png$/);

  const onDisk = await fsp.readFile(path.join(__dirname, '..', 'public', result.url));
  assert.ok(onDisk.equals(PNG));
  await fsp.unlink(path.join(__dirname, '..', 'public', result.url));
});

test('jpeg magic bytes are accepted too', async () => {
  const result = await upload.storePhoto(JPEG, 9);
  assert.equal(result.ok, true);
  assert.match(result.url, /\.jpg$/);
  await fsp.unlink(path.join(__dirname, '..', 'public', result.url));
});

test('non-image bytes are refused', async () => {
  const result = await upload.storePhoto(Buffer.from('<script>alert(1)</script>'), 9);
  assert.equal(result.ok, false);
  assert.match(result.error, /JPEG, PNG or WebP/);
});

test('photos over the 8 MB cap are refused', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(upload.MAX_BYTES + 1)]);
  const result = await upload.storePhoto(big, 9);
  assert.equal(result.ok, false);
  assert.match(result.error, /8 MB/);
});

test('empty body is refused', async () => {
  const result = await upload.storePhoto(Buffer.alloc(0), 9);
  assert.equal(result.ok, false);
});
