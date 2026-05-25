// ─────────────────────────────────────────────────────────────
// deck-store.js — durable storage for shared proposal decks.
//
// A "deck" is the full payload needed to re-render a proposal:
//   { client, proposal, mascotPaths, mascotTransforms, slideAssignments,
//     selectedSlides, ... }  — i.e. the same shape saveToHistory() builds,
//   but stored server-side so it survives across browsers/people and is
//   not bound by localStorage's ~5MB cap.
//
// Two backends, picked automatically:
//   • Local (`node server.js`)  → JSON files under  .deck-store/<id>/
//   • Vercel serverless         → @vercel/blob  (needs BLOB_READ_WRITE_TOKEN
//                                  env + `npm i @vercel/blob`; the FS is
//                                  read-only on Vercel so Blob is required).
//
// Every save creates a new version (vN.json) and refreshes latest.json,
// giving us a simple revision history for free.
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IS_VERCEL = !!process.env.VERCEL;
const ROOT = path.join(__dirname, '.deck-store');

// 12-char hex id — URL-safe, ~2^48 space (plenty for share links).
function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function _vNum(name) {
  const m = String(name).match(/v(\d+)\.json$/);
  return m ? parseInt(m[1], 10) : 0;
}

// ── Local filesystem backend ──────────────────────────────────
function _fsDir(id) { return path.join(ROOT, id); }

function _fsSave(id, data) {
  const dir = _fsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter(f => /^v\d+\.json$/.test(f));
  const nextV = existing.reduce((mx, f) => Math.max(mx, _vNum(f)), 0) + 1;
  const record = { id, version: nextV, ts: Date.now(), data };
  const body = JSON.stringify(record);
  fs.writeFileSync(path.join(dir, `v${nextV}.json`), body);
  fs.writeFileSync(path.join(dir, 'latest.json'), body);
  return record;
}

function _fsLoad(id) {
  const p = path.join(_fsDir(id), 'latest.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function _fsVersions(id) {
  const dir = _fsDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^v\d+\.json$/.test(f))
    .map(f => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { version: r.version, ts: r.ts };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

function _fsLoadVersion(id, version) {
  const p = path.join(_fsDir(id), `v${parseInt(version, 10)}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

// ── Vercel Blob backend ───────────────────────────────────────
let _blobMod = null;
function _blob() {
  if (_blobMod) return _blobMod;
  try {
    _blobMod = require('@vercel/blob');
  } catch (e) {
    throw new Error(
      'Shared-deck storage needs @vercel/blob on Vercel. Run `npm i @vercel/blob`, ' +
      'create a Blob store in the Vercel dashboard (sets BLOB_READ_WRITE_TOKEN), and redeploy.'
    );
  }
  return _blobMod;
}
const _blobPrefix = (id) => `decks/${id}/`;

async function _blobSave(id, data) {
  const { put, list } = _blob();
  const prefix = _blobPrefix(id);
  let nextV = 1;
  try {
    const { blobs } = await list({ prefix });
    const nums = blobs.map(b => _vNum(b.pathname)).filter(n => n > 0);
    if (nums.length) nextV = Math.max(...nums) + 1;
  } catch { /* first save */ }
  const record = { id, version: nextV, ts: Date.now(), data };
  const body = JSON.stringify(record);
  const opts = { access: 'public', contentType: 'application/json', addRandomSuffix: false };
  await put(`${prefix}v${nextV}.json`, body, opts);
  await put(`${prefix}latest.json`, body, Object.assign({ allowOverwrite: true }, opts));
  return record;
}

async function _blobLoad(id) {
  const { list } = _blob();
  const { blobs } = await list({ prefix: `${_blobPrefix(id)}latest.json` });
  if (!blobs.length) return null;
  const res = await fetch(blobs[0].url + '?t=' + Date.now()); // bust CDN cache
  if (!res.ok) return null;
  return await res.json();
}

async function _blobVersions(id) {
  const { list } = _blob();
  const { blobs } = await list({ prefix: _blobPrefix(id) });
  return blobs
    .map(b => ({ version: _vNum(b.pathname), ts: Date.parse(b.uploadedAt) || 0 }))
    .filter(v => v.version > 0)
    .sort((a, b) => a.version - b.version);
}

async function _blobLoadVersion(id, version) {
  const { list } = _blob();
  const v = parseInt(version, 10);
  const { blobs } = await list({ prefix: `${_blobPrefix(id)}v${v}.json` });
  if (!blobs.length) return null;
  const res = await fetch(blobs[0].url + '?t=' + Date.now());
  if (!res.ok) return null;
  return await res.json();
}

// ── Public API ────────────────────────────────────────────────
async function createDeck(data) {
  const id = newId();
  return IS_VERCEL ? _blobSave(id, data) : _fsSave(id, data);
}

async function updateDeck(id, data) {
  if (!/^[a-f0-9]{6,32}$/i.test(id)) throw new Error('bad deck id');
  return IS_VERCEL ? _blobSave(id, data) : _fsSave(id, data);
}

async function loadDeck(id) {
  if (!/^[a-f0-9]{6,32}$/i.test(id)) return null;
  return IS_VERCEL ? _blobLoad(id) : _fsLoad(id);
}

async function listVersions(id) {
  if (!/^[a-f0-9]{6,32}$/i.test(id)) return [];
  return IS_VERCEL ? _blobVersions(id) : _fsVersions(id);
}

async function loadVersion(id, version) {
  if (!/^[a-f0-9]{6,32}$/i.test(id)) return null;
  return IS_VERCEL ? _blobLoadVersion(id, version) : _fsLoadVersion(id, version);
}

module.exports = { createDeck, updateDeck, loadDeck, listVersions, loadVersion, newId };
