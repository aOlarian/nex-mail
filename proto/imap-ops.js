/* MAP
 * §1 imports        L12-L21
 * §2 fetch headers  L23-L64
 * §3 preview        L66-L97
 * §4 fetch raw      L99-L112
 * §5 flags & moves  L114-L159
 * §6 append & misc  L161-L176
 * §7 exports        L178-L179
 */
'use strict';

// §1 imports
// Metode amestecate in Imap.prototype; `this` este instanta Imap.
const { fetchAttrs, str } = require('./imap-parse');
const { imapError } = require('./imap-conn');
const cmd = require('./imap-cmd');
const st = require('./imap-struct');
const { parseDate } = require('./mime-words');

const BATCH = 300;
const PREVIEW_BYTES = 1500;

// §2 fetch headers
function fetchedByUid(res) {
  const map = new Map();
  for (const r of res.untagged) {
    if (r.type !== 'FETCH' || !r.data) continue;
    const a = fetchAttrs(r.data[0]);
    const uid = Number(str(a.UID));
    if (!uid) continue; // FETCH nesolicitat (schimbare de flaguri fara UID)
    map.set(uid, Object.assign(map.get(uid) || {}, a));
  }
  return map;
}

async function fetchHeaders(uids, opts) {
  this.requireMailbox(false);
  const wantPreview = !opts || opts.preview !== false;
  const out = [];
  for (const chunk of cmd.chunkUids(uids, BATCH)) {
    const res = await this.run([`UID FETCH ${cmd.compactSet(chunk)} (UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODYSTRUCTURE)`], { label: 'FETCH' });
    const items = [];
    for (const [uid, a] of fetchedByUid(res)) {
      const tree = st.parseBodyStructure(a.BODYSTRUCTURE);
      const env = st.parseEnvelope(a.ENVELOPE) || {};
      items.push({
        uid,
        flags: (Array.isArray(a.FLAGS) ? a.FLAGS : []).map((f) => String(str(f))),
        internalDate: parseDate(str(a.INTERNALDATE)),
        size: Number(str(a['RFC822.SIZE'])) || 0,
        envelope: {
          date: env.date || null, subject: env.subject || '', from: env.from || [], to: env.to || [],
          cc: env.cc || [], replyTo: env.replyTo || [], messageId: env.messageId || null, inReplyTo: env.inReplyTo || null,
        },
        hasAttachments: tree ? st.hasAttachments(tree) : false,
        preview: '',
        _tree: tree,
      });
    }
    if (wantPreview) await this.fillPreviews(items);
    for (const it of items) { delete it._tree; out.push(it); }
  }
  return out;
}

// §3 preview
// Un FETCH pe sectiune distincta (de obicei 2-3: TEXT, 1, 1.1) in loc de unul per mesaj.
async function fillPreviews(items) {
  const groups = new Map();
  for (const it of items) {
    const pick = it._tree ? st.previewPart(it._tree) : null;
    if (!pick) continue;
    it._pick = pick;
    if (!groups.has(pick.section)) groups.set(pick.section, []);
    groups.get(pick.section).push(it.uid);
  }
  const byUid = new Map(items.map((it) => [it.uid, it]));
  for (const [section, uids] of groups) {
    let res;
    try {
      res = await this.run([`UID FETCH ${cmd.compactSet(uids)} (UID BODY.PEEK[${section}]<0.${PREVIEW_BYTES}>)`], { label: 'FETCH' });
    } catch (e) {
      // previzualizarea e optionala: un NO/BAD aici nu trebuie sa piarda lista de mesaje
      if (e.code === 'NO' || e.code === 'BAD') continue;
      throw e;
    }
    for (const [uid, a] of fetchedByUid(res)) {
      const it = byUid.get(uid);
      if (!it || !it._pick) continue;
      const key = Object.keys(a).find((k) => k.startsWith('BODY['));
      const val = key ? a[key] : null;
      const buf = Buffer.isBuffer(val) ? val : val != null ? Buffer.from(String(val), 'utf8') : null;
      it.preview = st.decodePreview(buf, it._pick.node, 200);
    }
  }
  for (const it of items) delete it._pick;
}

// §4 fetch raw
async function fetchRaw(uid, maxBytes) {
  this.requireMailbox(false);
  const n = Number(uid);
  if (!Number.isInteger(n) || n <= 0) throw imapError('BAD', `UID invalid: ${uid}`);
  const part = maxBytes ? `BODY.PEEK[]<0.${Number(maxBytes)}>` : 'BODY.PEEK[]';
  const res = await this.run([`UID FETCH ${n} (UID ${part})`], { label: 'FETCH' });
  const a = fetchedByUid(res).get(n);
  if (!a) throw imapError('NO', `Mesajul UID ${n} nu exista in ${this.mailbox.path}`);
  const key = Object.keys(a).find((k) => k.startsWith('BODY['));
  const val = key ? a[key] : null;
  if (val == null) throw imapError('NO', `Serverul nu a intors continutul mesajului UID ${n}`);
  return Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8');
}

// §5 flags & moves
async function store(uids, op, flags) {
  this.requireMailbox(true);
  for (const chunk of cmd.chunkUids(uids, BATCH)) {
    await this.run([`UID STORE ${cmd.compactSet(chunk)} ${op}FLAGS.SILENT ${cmd.flagList(flags)}`], { label: 'STORE' });
  }
  return true;
}

function addFlags(uids, flags) { return this.store(uids, '+', flags); }
function removeFlags(uids, flags) { return this.store(uids, '-', flags); }

async function copy(uids, dest) {
  this.requireMailbox(false);
  for (const chunk of cmd.chunkUids(uids, BATCH)) {
    await this.run([`UID COPY ${cmd.compactSet(chunk)} `, cmd.mailbox(dest)], { label: 'COPY' });
  }
  return true;
}

async function move(uids, dest) {
  this.requireMailbox(true);
  if (!cmd.chunkUids(uids, 1).length) return true;
  if (this.caps.has('MOVE')) {
    for (const chunk of cmd.chunkUids(uids, BATCH)) {
      await this.run([`UID MOVE ${cmd.compactSet(chunk)} `, cmd.mailbox(dest)], { label: 'MOVE' });
    }
    return true;
  }
  await this.copy(uids, dest);
  await this.expunge(uids);
  return true;
}

// Fara UIDPLUS, EXPUNGE sterge toate mesajele marcate \Deleted din folder (limita protocolului).
async function expunge(uids) {
  this.requireMailbox(true);
  const list = cmd.chunkUids(uids, BATCH);
  if (!list.length) { await this.run(['EXPUNGE']); return true; }
  await this.store(uids, '+', ['\\Deleted']);
  for (const chunk of list) {
    if (this.caps.has('UIDPLUS')) await this.run([`UID EXPUNGE ${cmd.compactSet(chunk)}`], { label: 'EXPUNGE' });
  }
  if (!this.caps.has('UIDPLUS')) await this.run(['EXPUNGE']);
  return true;
}

// §6 append & misc
async function append(path, raw, flags) {
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const fl = flags && flags.length ? cmd.flagList(flags) + ' ' : '';
  const res = await this.run(['APPEND ', cmd.mailbox(path), ' ' + fl, { literal: body }], { label: 'APPEND' });
  if (res.code === 'APPENDUID' && res.args && res.args[1]) {
    const uid = Number(res.args[1]);
    return Number.isInteger(uid) ? uid : null;
  }
  return null;
}

async function noop() {
  await this.run(['NOOP']);
  return true;
}

// §7 exports
module.exports = { fetchHeaders, fillPreviews, fetchRaw, store, addFlags, removeFlags, copy, move, expunge, append, noop };
