'use strict'
/* MAP
 * §1 imports & constante                L12-L48
 * §2 cale, useri, cheia masinii         L49-L76
 * §3 criptare parole                    L77-L79
 * §4 JSON atomic + coada scrieri        L80-L154
 * §5 conturi                            L155-L256
 * §6 profil (setari, categorii)         L257-L288
 * §7 export                             L289-L294
 */

// §1 imports & constante
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

const USER_RE = /^[a-z0-9._-]{1,64}$/

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'light', density: 'comfortable', fontSize: 'normal', readingPane: 'right',
  markReadSeconds: 2, showImages: 'ask', pollSeconds: 120, pageSize: 50, autoCalendar: true,
})

const DEFAULT_CATEGORIES = Object.freeze([
  { id: 'red', name: 'Important', color: '#d13438' },
  { id: 'orange', name: 'Follow up', color: '#ca5010' },
  { id: 'yellow', name: 'Waiting', color: '#c19c00' },
  { id: 'green', name: 'Done', color: '#107c10' },
  { id: 'blue', name: 'Client', color: '#0078d4' },
  { id: 'purple', name: 'Personal', color: '#8764b8' },
])
const DEFAULT_FILTERED_FOLDERS = Object.freeze([
  { id: 'spam', name: 'SPAM', system: true },
  { id: 'scam', name: 'SCAM', system: true },
  { id: 'newsletter', name: 'Newsletter', system: true },
  { id: 'ignore', name: 'Ignore', system: true },
])

const FILE_DEFAULTS = {
  'accounts.json': () => ({ accounts: [] }),
  'profile.json': () => ({}),
  'meta.json': () => ({}),
  'calendar.json': () => ({ events: [] }),
  'sync.json': () => ({}),
  'contacts.json': () => ({ items: [] }),
}

// §2 cale, useri, cheia masinii
// Evaluat la fiecare apel: testele seteaza NEX_MAIL_DATA dupa require.
function dataRoot() {
  return process.env.NEX_MAIL_DATA || 'C:\\ProgramData\\Nex\\nex-mail'
}

/** Numele vine din antet; doar puncte ar insemna iesire din users/ ('..'). */
function validUser(name) {
  return typeof name === 'string' && USER_RE.test(name) && !/^\.+$/.test(name)
}

function userDir(user) {
  if (!validUser(user)) throw new Error('user invalid')
  return path.join(dataRoot(), 'users', user)
}

function listUsers() {
  const dir = path.join(dataRoot(), 'users')
  let names
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return names.filter((d) => d.isDirectory() && validUser(d.name)).map((d) => d.name)
}

// §3 criptare parole (src/store-crypto.js)
const { machineKey, encrypt, decrypt, forgetKey } = require('./store-crypto')(dataRoot)

// §4 JSON atomic + coada scrieri
// cale → { value, mtime }. Uneltele din tools/ scriu direct pe disc cat serviciul ruleaza: mtime-ul
// schimbat invalideaza cache-ul, altfel urmatoarea scriere a serviciului le-ar sterge modificarile.
const cache = new Map()
const queues = new Map() // cale → Promise (scrieri serializate)

function filePath(user, name) {
  if (!FILE_DEFAULTS[name]) throw new Error('fisier necunoscut: ' + name)
  return path.join(userDir(user), name)
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs } catch (err) { return err.code === 'ENOENT' ? 0 : -1 }
}

function loadSync(file, name) {
  const hit = cache.get(file)
  const mtime = mtimeOf(file)
  if (hit && hit.mtime === mtime) return hit.value
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    // Fisier lipsa = valori implicite; JSON corupt = pastram copia ca sa nu pierdem date in tacere.
    if (err.code !== 'ENOENT') {
      console.error(`[mail] ${path.basename(file)} ilizibil, pornesc gol (copie .corrupt)`)
      fs.copyFile(file, file + '.corrupt', (e) => e && console.error('[mail] copie .corrupt esuata:', e.code))
    }
    value = FILE_DEFAULTS[name]()
  }
  cache.set(file, { value, mtime })
  return value
}

/** Copie profunda: apelantul nu are voie sa modifice cache-ul ocolind coada. */
function read(user, name) {
  return structuredClone(loadSync(filePath(user, name), name))
}

async function writeAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 1), { mode: 0o600 })
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (err) {
      // Pe Windows un cititor/antivirus poate tine fisierul o clipa (EPERM/EBUSY).
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fsp.unlink(tmp).catch(() => null) // tmp ramas nu conteaza, eroarea reala urca
        throw err
      }
      await new Promise((r) => setTimeout(r, 30 * (i + 1)))
    }
  }
}

/** mutator(obj) modifica pe loc si intoarce rezultatul; scrierile pe acelasi fisier merg la rand. */
function update(user, name, mutator) {
  const file = filePath(user, name)
  const prev = queues.get(file) || Promise.resolve()
  // Eroarea scrierii anterioare a primit-o deja apelantul ei; coada merge mai departe.
  const next = prev.catch(() => null).then(async () => {
    const work = structuredClone(loadSync(file, name))
    const result = await mutator(work)
    await writeAtomic(file, work)
    cache.set(file, { value: work, mtime: mtimeOf(file) })
    return result
  })
  queues.set(file, next)
  next.finally(() => queues.get(file) === next && queues.delete(file)).catch(() => null)
  return next
}

// §5 conturi
function newId(prefix) {
  return prefix + crypto.randomBytes(6).toString('hex')
}

function cleanServer(s, defPort, defSecure) {
  const host = String((s && s.host) || '').trim().toLowerCase()
  if (!host || host.length > 255 || !/^[a-z0-9.-]+$/.test(host)) throw Object.assign(new Error('Server invalid: ' + (host || 'gol')), { status: 400 })
  const port = Number(s.port) || defPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Port invalid'), { status: 400 })
  return { host, port, secure: s.secure === undefined ? defSecure : !!s.secure }
}

function getAccount(user, id) {
  return read(user, 'accounts.json').accounts.find((a) => a.id === id) || null
}

function getPassword(user, id) {
  const acc = getAccount(user, id)
  return acc && acc.password ? decrypt(acc.password) : ''
}

/** Forma publica: fara parola, doar hasPassword + starea sincronizarii. */
function publicAccount(acc, syncState) {
  const { password, ...rest } = acc
  const s = syncState || {}
  return { ...rest, hasPassword: !!password, status: { ok: !s.error, error: s.error || null, lastSync: s.lastSync || null } }
}

async function saveAccount(user, input) {
  const email = String(input.email || '').trim()
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw Object.assign(new Error('Adresa de email invalida'), { status: 400 })
  const clean = {
    name: String(input.name || email).slice(0, 120),
    email,
    user: String(input.user || email).trim().slice(0, 255),
    color: /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : '#0078d4',
    imap: cleanServer(input.imap, 993, true),
    smtp: cleanServer(input.smtp, 465, true),
    insecureTls: input.insecureTls === true,
    signatureNew: input.signatureNew ? String(input.signatureNew) : null,
    signatureReply: input.signatureReply ? String(input.signatureReply) : null,
  }
  if (input.sentFolder) clean.sentFolder = String(input.sentFolder).slice(0, 500)
  if (input.groupId !== undefined) clean.groupId = input.groupId ? String(input.groupId).slice(0, 40) : null
  const saved = await update(user, 'accounts.json', (data) => {
    let acc = input.id ? data.accounts.find((a) => a.id === input.id) : null
    if (input.id && !acc) throw Object.assign(new Error('Account not found'), { status: 404 })
    if (!acc) {
      acc = { id: newId('a') }
      data.accounts.push(acc)
    }
    if (!clean.sentFolder) delete acc.sentFolder
    Object.assign(acc, clean)
    if (acc.groupId === null) delete acc.groupId
    if (typeof input.password === 'string' && input.password !== '') acc.password = encrypt(input.password)
    return structuredClone(acc)
  })
  // Parola/serverul s-au putut schimba: anulam backoff-ul de autentificare.
  await update(user, 'sync.json', (s) => {
    if (s[saved.id]) delete s[saved.id].authFailAt
  })
  return saved
}

async function reorderAccounts(user, items) {
  return update(user, 'accounts.json', (data) => {
    const byId = new Map(data.accounts.map((a) => [a.id, a]))
    const ordered = []
    for (const entry of items) {
      const id = typeof entry === 'string' ? entry : entry && entry.id
      const acc = byId.get(id)
      if (!acc) continue
      byId.delete(id)
      if (entry && typeof entry === 'object' && entry.groupId !== undefined) {
        if (entry.groupId) acc.groupId = String(entry.groupId).slice(0, 40)
        else delete acc.groupId
      }
      ordered.push(acc)
    }
    for (const rest of byId.values()) ordered.push(rest)
    data.accounts = ordered
    return ordered.map((a) => structuredClone(a))
  })
}

async function deleteAccount(user, id) {
  const found = await update(user, 'accounts.json', (data) => {
    const before = data.accounts.length
    data.accounts = data.accounts.filter((a) => a.id !== id)
    return data.accounts.length !== before
  })
  if (!found) return false
  await update(user, 'meta.json', (meta) => {
    for (const k of Object.keys(meta)) if (k.startsWith(id + '|')) delete meta[k]
  })
  await update(user, 'sync.json', (s) => {
    delete s[id]
  })
  return true
}

// §6 profil (setari, categorii)
function getProfile(user) {
  const p = read(user, 'profile.json')
  return {
    settings: { ...DEFAULT_SETTINGS, ...(p.settings || {}) },
    categories: Array.isArray(p.categories) ? p.categories : structuredClone(DEFAULT_CATEGORIES),
    signatures: Array.isArray(p.signatures) ? p.signatures : [],
    rules: Array.isArray(p.rules) ? p.rules : [],
    accountGroups: Array.isArray(p.accountGroups) ? p.accountGroups : [],
    filteredFolders: Array.isArray(p.filteredFolders) ? p.filteredFolders : structuredClone(DEFAULT_FILTERED_FOLDERS),
  }
}

/** key ∈ settings|categories|signatures|rules; valoarea e deja validata de apelant. */
async function setProfile(user, key, value) {
  await update(user, 'profile.json', (p) => {
    p[key] = value
  })
  return getProfile(user)[key]
}

function ensureUser(user) {
  fs.mkdirSync(userDir(user), { recursive: true })
}

/** Doar pentru teste: uita cache-ul si cheia (alt NEX_MAIL_DATA). */
function resetForTests() {
  cache.clear()
  queues.clear()
  forgetKey()
}

// §7 export
module.exports = {
  DEFAULT_SETTINGS, DEFAULT_CATEGORIES, DEFAULT_FILTERED_FOLDERS, dataRoot, validUser, userDir, ensureUser, listUsers,
  machineKey, encrypt, decrypt, read, update, newId, getAccount, getPassword, publicAccount, saveAccount,
  reorderAccounts, deleteAccount, getProfile, setProfile, resetForTests,
}
