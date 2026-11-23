'use strict'
/* MAP
 * §1 imports & dependinte injectabile   L12-L43
 * §2 erori HTTP si mesaje umane         L44-L80
 * §3 validare parametri                 L81-L117
 * §4 chei meta, foldere speciale        L118-L171
 * §5 adrese si contacte                 L172-L218
 * §6 invalidare cache-uri               L219-L230
 * §7 export                             L231-L256
 */

// §1 imports & dependinte injectabile
const store = require('./store')

const overrides = {}

/** proto/<name> incarcat la prima folosire; teste: setProto(name, dubla). */
function proto(name) {
  if (overrides[name]) return overrides[name]
  try {
    return require('../proto/' + name)
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && String(err.message).includes('proto')) {
      throw httpError(503, `Modulul de protocol „${name}” lipseste din instalare`)
    }
    throw err
  }
}

function setProto(name, impl) {
  if (impl) overrides[name] = impl
  else delete overrides[name]
}

/** SMTP real sau dubla (send/verify) pentru teste. */
function smtp() {
  return overrides.smtp || proto('smtp')
}

function setSmtp(impl) {
  setProto('smtp', impl)
}

// §2 erori HTTP si mesaje umane
function httpError(status, message) {
  return Object.assign(new Error(message), { status, human: true })
}

const TLS_RE = /certificate|self[- ]signed|CERT_|UNABLE_TO_VERIFY|ALTNAME|unable to get local issuer/i
const NET_CODES = new Set(['CONNECT', 'TIMEOUT', 'CLOSED', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'])

function isTlsError(err) {
  const parts = [err.code, err.message, err.cause && err.cause.code, err.cause && err.cause.message]
  return parts.some((p) => p && TLS_RE.test(String(p)))
}

/** Mesajul pentru om; serverul poate intoarce text tehnic, il pastram scurt. */
function humanError(err) {
  if (!err) return 'Eroare necunoscuta'
  if (err.human) return err.message
  if (isTlsError(err)) return 'Certificat TLS invalid — bifeaza «Accepta certificat nesigur» doar daca ai incredere in server'
  if (err.code === 'AUTH') return 'Parola sau utilizatorul gresit'
  if (NET_CODES.has(err.code)) return 'Serverul nu raspunde'
  if (err.code === 'REJECTED') return 'Serverul de trimitere a refuzat mesajul: ' + shortServerText(err.message)
  if (err.code === 'NO' || err.code === 'BAD') return 'Serverul a refuzat operatia: ' + shortServerText(err.message)
  return 'Eroare interna'
}

function shortServerText(msg) {
  return String(msg || '').replace(/[\r\n]+/g, ' ').slice(0, 200)
}

function statusFor(err) {
  if (err && Number.isInteger(err.status)) return err.status
  // 502, nu 401: 401 l-ar putea interpreta UI-ul/poarta drept sesiune Nex expirata.
  if (err && (err.code === 'AUTH' || NET_CODES.has(err.code) || isTlsError(err))) return 502
  if (err && (err.code === 'NO' || err.code === 'BAD' || err.code === 'REJECTED')) return 502
  return 500
}

// §3 validare parametri
function requireAccount(user, id) {
  if (!id || typeof id !== 'string') throw httpError(400, 'Lipseste contul')
  const acc = store.getAccount(user, id)
  if (!acc) throw httpError(404, 'Contul nu exista')
  return acc
}

function requireFolder(folder) {
  if (typeof folder !== 'string' || !folder || folder.length > 1000 || /[\r\n\0]/.test(folder)) {
    throw httpError(400, 'Folder invalid')
  }
  return folder
}

function toUid(v) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 4294967295) throw httpError(400, 'UID invalid')
  return n
}

function toUids(list) {
  if (!Array.isArray(list) || !list.length) throw httpError(400, 'Lipsesc mesajele')
  if (list.length > 5000) throw httpError(400, 'Prea multe mesaje intr-o operatie')
  return [...new Set(list.map(toUid))]
}

function intIn(v, def, min, max) {
  const n = Number(v)
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}

function str(v, max = 10000) {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

// §4 chei meta, foldere speciale
function normId(id) {
  return String(id || '').trim().replace(/^<|>$/g, '')
}

/** Cheie meta: messageId (supravietuieste mutarilor); fara el, folder+uid. */
function metaKey(accountId, messageId, folder, uid) {
  const id = normId(messageId)
  return id ? `${accountId}|${id}` : `${accountId}|uid:${folder}:${uid}`
}

const SPECIAL_NAMES = {
  '\\Sent': ['sent', 'sent items', 'sent messages', 'trimise', 'elemente trimise'],
  '\\Drafts': ['drafts', 'ciorne'],
  '\\Trash': ['trash', 'deleted items', 'deleted messages', 'cos', 'cos de gunoi', 'elemente sterse'],
  '\\Junk': ['junk', 'spam', 'junk e-mail', 'nedorite'],
  '\\Archive': ['archive', 'arhiva'],
}

function leaf(f) {
  const d = f.delimiter
  return (d && f.path.includes(d) ? f.path.slice(f.path.lastIndexOf(d) + d.length) : f.path).toLowerCase()
}

function findSpecialIn(list, use) {
  const exact = list.find((f) => f.specialUse === use && !f.noselect)
  if (exact) return exact
  const names = SPECIAL_NAMES[use] || []
  return list.find((f) => !f.noselect && names.includes(leaf(f))) || null
}

/**
 * Folderul special pe conexiunea data (suntem deja sub lacatul ei: NU chema pool aici).
 * Daca lipseste, il creeaza la radacina cu numele implicit.
 */
async function findSpecialOn(c, use, fallbackName, user, accountId) {
  const list = await c.list()
  const hit = findSpecialIn(list, use)
  if (hit) return hit.path
  await c.create(fallbackName)
  try {
    await c.subscribe(fallbackName)
  } catch (err) {
    console.error('[mail] subscribe esuat:', err.code || 'eroare')
  }
  if (user) invalidate(user, accountId)
  return fallbackName
}

function isSpecialPath(list, path, use) {
  const f = findSpecialIn(list, use)
  return !!f && f.path === path
}

// §5 adrese si contacte
/** Accepta string „Nume <a@b>, c@d”, lista de string-uri sau lista de {name,address}. */
function parseAddressList(v) {
  if (!v) return []
  const items = Array.isArray(v) ? v : [v]
  const out = []
  for (const it of items) {
    if (!it) continue
    if (typeof it === 'object') {
      if (it.address) out.push({ name: str(it.name, 200), address: String(it.address).trim() })
      continue
    }
    for (const a of proto('mime').parseAddresses(String(it))) {
      if (a && a.address) out.push({ name: a.name || '', address: String(a.address).trim() })
    }
  }
  for (const a of out) {
    if (!/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(a.address)) throw httpError(400, `Adresa invalida: ${a.address.slice(0, 100)}`)
  }
  return out
}

/** Adauga/actualizeaza contacte (din From la primire, din destinatari la trimitere). */
async function addContacts(user, list) {
  const clean = (list || []).filter((a) => a && a.address && a.address.includes('@'))
  if (!clean.length) return
  const now = new Date().toISOString()
  await store.update(user, 'contacts.json', (data) => {
    for (const a of clean) {
      const address = a.address.toLowerCase()
      let c = data.items.find((x) => x.address === address)
      if (!c) {
        c = { name: '', address, count: 0 }
        data.items.push(c)
      }
      if (a.name && !/@/.test(a.name)) c.name = a.name
      c.count++
      c.last = now
    }
    // Plafon: pastram cele mai folosite/recente.
    if (data.items.length > 5000) {
      data.items.sort((x, y) => y.count - x.count || String(y.last).localeCompare(String(x.last)))
      data.items.length = 5000
    }
  })
}

// §6 invalidare cache-uri
const invalidators = []

/** Modulele cu cache (foldere, liste) se inregistreaza aici. */
function onInvalidate(fn) {
  invalidators.push(fn)
}

function invalidate(user, accountId, folder) {
  for (const fn of invalidators) fn(user, accountId, folder)
}

// §7 export
module.exports = {
  proto,
  setProto,
  smtp,
  setSmtp,
  httpError,
  humanError,
  statusFor,
  isTlsError,
  requireAccount,
  requireFolder,
  toUid,
  toUids,
  intIn,
  str,
  normId,
  metaKey,
  findSpecialIn,
  findSpecialOn,
  isSpecialPath,
  parseAddressList,
  addContacts,
  onInvalidate,
  invalidate,
}
