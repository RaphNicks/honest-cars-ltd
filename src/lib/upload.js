'use strict';

/**
 * Direct photo upload (§7.2 “add photos”). The wizard used to store photos by
 * link only and told people to WhatsApp shots to the ops desk — now the file
 * travels with the form. Bytes arrive raw (express.raw in app.js), are checked
 * by magic number rather than by the client's word, and land under
 * public/uploads/photos/u<id>/ where express.static serves them back.
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per photo

const KINDS = [
  { ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

/** @returns {{ok:true,url:string,bytes:number}|{ok:false,error:string}} */
async function storePhoto(buffer, ownerId) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: 'No image received.' };
  }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: 'That photo is over the 8 MB limit — send a smaller one.' };
  }
  const kind = KINDS.find((k) => k.test(buffer));
  if (!kind) {
    return { ok: false, error: 'Only JPEG, PNG or WebP photos are accepted.' };
  }
  const owner = `u${Number(ownerId) || 0}`;
  const dir = path.join(PUBLIC_DIR, 'uploads', 'photos', owner);
  await fsp.mkdir(dir, { recursive: true });
  const name = `${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 20)}.${kind.ext}`;
  await fsp.writeFile(path.join(dir, name), buffer);
  return { ok: true, url: `/uploads/photos/${owner}/${name}`, bytes: buffer.length };
}

module.exports = { storePhoto, MAX_BYTES };
