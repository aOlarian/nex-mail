'use strict'
/* MAP
 * §1 imports & dubla SMTP               L11-L29
 * §2 imagini inline → cid:              L30-L81
 * §3 construire mesaj                   L82-L126
 * §4 trimitere                          L127-L173
 * §5 ciorna                             L174-L195
 * §6 rute                               L196-L201
 */

// §1 imports & dubla SMTP
const crypto = require('crypto')
const store = require('./store')
const pool = require('./pool')
const common = require('./api-common')
const messages = require('./api-messages')
const { httpError, requireAccount, requireFolder, toUid, str } = common

let sender = null

/** Teste: fn(cfg, { from, recipients, raw }) → { accepted, rejected, response }. null = SMTP real. */
function setSender(fn) {
  sender = fn
}

function smtpSend(cfg, msg) {
  return sender ? sender(cfg, msg) : common.smtp().send(cfg, msg)
}

// §2 imagini inline → cid:
const URL_RE = /\/api\/mail\/attachment\?([^"'\s>)]+)/g
const DATA_RE = /data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)/g

/**
 * Imaginile locale (/api/mail/attachment) si cele incorporate (data:image/...;base64)
 * devin parti inline (cid:), altfel destinatarul le vede sparte sau blocate.
 */
async function relinkInline(user, accountId, html) {
  const refs = new Map() // url → { folder, uid, part }
  for (const m of html.matchAll(URL_RE)) {
    const p = new URLSearchParams(m[1].replace(/&amp;/g, '&'))
    if (p.get('account') !== accountId || !p.get('folder') || !p.get('uid') || !p.get('part')) continue
    refs.set(m[0], { folder: p.get('folder'), uid: Number(p.get('uid')), part: p.get('part') })
  }
  const inline = []
  const cidOf = new Map()
  for (const [url, r] of refs) {
    const key = `${r.folder}|${r.uid}|${r.part}`
    if (!cidOf.has(key)) {
      let a = null
      try {
        const { parsed } = await messages.loadMessage(user, accountId, r.folder, toUid(r.uid), { header: false })
        a = (parsed.attachments || []).find((x) => String(x.id) === r.part)
      } catch (err) {
        // Originalul a disparut: imaginea ramane link (sparta), mesajul pleaca oricum.
        console.error('[mail] imagine inline indisponibila:', err.code || err.status || err.name)
      }
      if (!a || !a.content) continue
      const cid = common.normId(a.contentId) || `${crypto.randomBytes(8).toString('hex')}@nex-mail`
      cidOf.set(key, cid)
      inline.push({ filename: a.filename || 'imagine', contentType: a.contentType || 'application/octet-stream', content: a.content, contentId: cid })
    }
    html = html.split(url).join('cid:' + cidOf.get(key))
  }
  const dataCids = new Map()
  html = html.replace(DATA_RE, (full, mime, b64) => {
    const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64')
    if (!buf.length) return full
    const hash = `${mime}|${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}`
    if (!dataCids.has(hash)) {
      const cid = `${crypto.randomBytes(8).toString('hex')}@nex-mail`
      const ext = mime.split('/')[1].replace('jpeg', 'jpg')
      dataCids.set(hash, cid)
      inline.push({ filename: `inline-${inline.length + 1}.${ext}`, contentType: mime, content: buf, contentId: cid })
    }
    return 'cid:' + dataCids.get(hash)
  })
  return { html, inline }
}

// §3 construire mesaj
function cleanAttachments(list) {
  if (!list) return []
  if (!Array.isArray(list)) throw httpError(400, 'Atasamente invalide')
  return list.map((a) => {
    if (!a || typeof a.dataB64 !== 'string') throw httpError(400, 'Atasament fara continut')
    return { filename: str(a.filename, 255) || 'atasament', contentType: str(a.contentType, 200) || 'application/octet-stream', content: Buffer.from(a.dataB64, 'base64') }
  })
}

function cleanRefs(v) {
  if (Array.isArray(v)) return v.map((x) => str(String(x), 1000)).filter(Boolean).slice(0, 100)
  if (typeof v === 'string') return v.split(/\s+/).filter(Boolean).slice(0, 100)
  return []
}

async function prepare(user, body) {
  const acc = requireAccount(user, body.account)
  const to = common.parseAddressList(body.to)
  const cc = common.parseAddressList(body.cc)
  const bcc = common.parseAddressList(body.bcc)
  const attachments = cleanAttachments(body.attachments)
  const relinked = await relinkInline(user, acc.id, typeof body.html === 'string' ? body.html : '')
  if (body.forward) {
    const fwdAcc = body.forward.account === '__local__' ? '__local__' : acc.id
    const { parsed } = await messages.loadMessage(user, fwdAcc, requireFolder(body.forward.folder), toUid(body.forward.uid), { header: false })
    for (const a of parsed.attachments || []) {
      if (a.inline || !a.content) continue
      attachments.push({ filename: a.filename || 'atasament', contentType: a.contentType || 'application/octet-stream', content: a.content })
    }
  }
  const built = common.proto('build').build({
    from: { name: acc.name || '', address: acc.email },
    to,
    cc,
    bcc,
    subject: str(body.subject, 2000),
    html: relinked.html,
    inReplyTo: str(body.inReplyTo, 1000) || undefined,
    references: cleanRefs(body.references),
    attachments: [...attachments, ...relinked.inline],
    date: new Date(),
  })
  return { acc, built, recipients: [...to, ...cc, ...bcc] }
}

// §4 trimitere
async function afterSend(user, acc, body, raw) {
  let sentSaved = false
  // Gmail pune singur copia in Sent la trimiterea prin SMTP; un APPEND ar dubla-o.
  if (/(^|\.)gmail\.com$|(^|\.)googlemail\.com$/.test(acc.imap.host)) sentSaved = true
  else try {
    await pool.run(user, acc.id, async (c) => {
      const path = acc.sentFolder || (await common.findSpecialOn(c, '\\Sent', 'Sent', user, acc.id))
      await c.append(path, raw, ['\\Seen'])
    })
    sentSaved = true
  } catch (err) {
    console.error('[mail] copia in Sent a esuat:', err.code || err.name)
  }
  if (body.replyTo) {
    try {
      await pool.withFolder(user, acc.id, requireFolder(body.replyTo.folder), (c) => c.addFlags([toUid(body.replyTo.uid)], ['\\Answered']))
    } catch (err) {
      console.error('[mail] marcare \\Answered esuata:', err.code || err.name)
    }
  }
  if (body.draft) await dropDraft(user, acc.id, body.draft)
  return sentSaved
}

async function dropDraft(user, accountId, draft) {
  try {
    await pool.withFolder(user, accountId, requireFolder(draft.folder), (c) => c.expunge([toUid(draft.uid)]))
  } catch (err) {
    console.error('[mail] stergere ciorna esuata:', err.code || err.status || err.name)
  }
}

async function postSend({ user, body }) {
  const { acc, built, recipients } = await prepare(user, body)
  if (!built.recipients || !built.recipients.length) throw httpError(400, 'Adauga cel putin un destinatar')
  const result = await smtpSend(pool.smtpConfig(acc, store.getPassword(user, acc.id)), { from: acc.email, recipients: built.recipients, raw: built.raw })
  if (result && Array.isArray(result.accepted) && !result.accepted.length) throw httpError(502, 'Serverul de trimitere a refuzat toti destinatarii')
  const sentSaved = await afterSend(user, acc, body, built.raw)
  await common.addContacts(user, recipients).catch((err) => console.error('[mail] contacte nesalvate:', err.code || err.name))
  common.invalidate(user, acc.id)
  const out = { ok: true, messageId: built.messageId, sentSaved }
  if (result && Array.isArray(result.rejected) && result.rejected.length) out.rejected = result.rejected
  return out
}

// §5 ciorna
async function postDraft({ user, body }) {
  const { acc, built } = await prepare(user, body)
  const saved = await pool.run(user, acc.id, async (c) => {
    const folder = await common.findSpecialOn(c, '\\Drafts', 'Drafts', user, acc.id)
    return { folder, uid: await c.append(folder, built.raw, ['\\Draft', '\\Seen']) }
  })
  // Fara APPENDUID: cautam ciorna dupa Message-ID, ca urmatoarea salvare sa o poata inlocui.
  if (!saved.uid && built.messageId && !/["\\\r\n]/.test(built.messageId)) {
    try {
      const id = common.normId(built.messageId)
      const hit = await pool.withFolder(user, acc.id, saved.folder, (c) => c.search(`HEADER Message-ID "<${id}>"`))
      saved.uid = hit.length ? Math.max(...hit) : null
    } catch (err) {
      console.error('[mail] ciorna negasita dupa APPEND:', err.code || err.name)
    }
  }
  if (body.draft && !(body.draft.folder === saved.folder && Number(body.draft.uid) === saved.uid)) await dropDraft(user, acc.id, body.draft)
  common.invalidate(user, acc.id)
  return { ok: true, folder: saved.folder, uid: saved.uid || null }
}

// §6 rute
module.exports = {
  setSender,
  relinkInline,
  routes: { 'POST send': postSend, 'POST draft': postDraft },
}
