'use strict'
/* MAP
 * §1 imports & config                   L10-L26
 * §2 config IMAP/SMTP din cont          L27-L51
 * §3 conexiuni + coada                  L52-L154
 * §4 API public                         L155-L206
 * §5 export                             L207-L219
 */

// §1 imports & config
const store = require('./store')

const IDLE_MS = 60 * 1000
const MAX_PER_HOST = 6
const NETWORK_CODES = new Set(['CONNECT', 'CLOSED', 'TIMEOUT', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED'])

let connector = (cfg) => {
  const { Imap } = require('../proto/imap')
  return new Imap(cfg)
}

/** Teste: inlocuieste `new Imap(cfg)` cu o dubla. */
function setConnector(fn) {
  connector = fn
}

// §2 config IMAP/SMTP din cont
function imapConfig(account, pass) {
  return {
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure !== false,
    user: account.user || account.email,
    pass,
    rejectUnauthorized: !account.insecureTls,
    timeoutMs: 30000,
  }
}

function smtpConfig(account, pass) {
  return {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure !== false,
    user: account.user || account.email,
    pass,
    rejectUnauthorized: !account.insecureTls,
    timeoutMs: 30000,
  }
}

// §3 conexiuni + coada
const entries = new Map() // `${user}|${accountId}` → { client, folder, readOnly, info, tail, timer }

function entryFor(user, accountId) {
  const key = `${user}|${accountId}`
  let e = entries.get(key)
  if (!e) {
    e = { key, host: '', client: null, folder: null, readOnly: false, info: null, inFlight: 0, lastUsed: 0, tail: Promise.resolve(), timer: null }
    entries.set(key, e)
  }
  return e
}

function evictHostIdle(host, skipKey) {
  if (!host) return
  const live = [...entries.values()].filter((x) => x.key !== skipKey && x.host === host && x.client && !x.client.closed)
  if (live.length < MAX_PER_HOST) return
  const idle = live.filter((x) => x.inFlight === 0).sort((a, b) => a.lastUsed - b.lastUsed)
  for (let i = 0; i < idle.length && live.length - i >= MAX_PER_HOST; i++) dropClient(idle[i])
}

function isNetworkError(err, client) {
  return !!err && (NETWORK_CODES.has(err.code) || !!(client && client.closed))
}

function dropClient(e) {
  const c = e.client
  e.client = null
  e.folder = null
  e.info = null
  if (c && !c.closed) {
    Promise.resolve()
      .then(() => c.logout())
      .catch((err) => console.error('[mail] logout esuat:', err.code || 'eroare'))
  }
}

async function ensureClient(e, user, accountId) {
  if (e.client && !e.client.closed) return e.client
  e.client = null
  e.folder = null
  const account = store.getAccount(user, accountId)
  if (!account) throw Object.assign(new Error('Contul nu exista'), { status: 404 })
  e.host = (account.imap && account.imap.host) || ''
  evictHostIdle(e.host, e.key)
  const client = connector(imapConfig(account, store.getPassword(user, accountId)))
  if (typeof client.on === 'function') {
    client.on('close', () => {
      if (e.client === client) {
        e.client = null
        e.folder = null
      }
    })
    // Fara ascultator, un 'error' emis ar arunca in proces.
    client.on('error', (err) => console.error('[mail] imap:', err.code || 'eroare'))
  }
  await client.connect()
  e.client = client
  return client
}

function armIdle(e) {
  if (e.timer) clearTimeout(e.timer)
  e.timer = setTimeout(() => {
    // Inchidem doar daca nu s-a pus nimic in coada intre timp.
    e.tail = e.tail.then(() => {
      dropClient(e)
      entries.delete(e.key)
    })
  }, IDLE_MS)
  if (e.timer.unref) e.timer.unref()
}

/** Pune fn(client) in coada conexiunii; o reincercare dupa reconectare la eroare de retea. */
function run(user, accountId, fn) {
  const e = entryFor(user, accountId)
  const job = e.tail.then(async () => {
    e.inFlight++
    let client = null
    try {
      try {
        client = await ensureClient(e, user, accountId)
        return await fn(client, e)
      } catch (err) {
        if (!isNetworkError(err, client)) throw err
        const freshErr = !client
        dropClient(e)
        evictHostIdle(e.host, e.key)
        if (freshErr) await new Promise((r) => setTimeout(r, 80))
        client = await ensureClient(e, user, accountId)
        return await fn(client, e)
      }
    } finally {
      e.inFlight--
      e.lastUsed = Date.now()
      armIdle(e)
    }
  })
  // Coada continua si dupa un job esuat; eroarea o primeste apelantul prin `job`.
  e.tail = job.catch(() => null)
  return job
}

// §4 API public
/** SELECT/EXAMINE doar daca folderul curent difera; fn(client, info) ruleaza sub acelasi lacat. */
function withFolder(user, accountId, folder, fn, opts = {}) {
  const readOnly = !!opts.readOnly
  return run(user, accountId, async (c, e) => {
    // Un folder deschis read-write acopera si cererile read-only.
    if (e.folder !== folder || (e.readOnly && !readOnly)) {
      e.folder = null
      e.info = readOnly ? await c.examine(folder) : await c.select(folder)
      e.folder = folder
      e.readOnly = readOnly
    }
    return fn(c, e.info || {})
  })
}

/** Dupa redenumire/stergere de folder: urmatoarea operatie face SELECT din nou. */
function invalidateSelection(user, accountId) {
  const e = entries.get(`${user}|${accountId}`)
  if (e) e.tail = e.tail.then(() => {
    e.folder = null
  })
}

/** Cont modificat/sters: conexiunea veche nu mai e valabila. */
function drop(user, accountId) {
  const e = entries.get(`${user}|${accountId}`)
  if (!e) return
  entries.delete(e.key)
  e.tail = e.tail.then(() => dropClient(e))
  if (e.timer) clearTimeout(e.timer)
}

async function closeAll() {
  const all = [...entries.values()]
  entries.clear()
  await Promise.all(
    all.map((e) => {
      if (e.timer) clearTimeout(e.timer)
      return e.tail.then(() => dropClient(e))
    }),
  )
}

/** Conexiune noua, in afara poolului (Testeaza contul). */
async function probe(account, pass) {
  const c = connector(imapConfig(account, pass))
  if (typeof c.on === 'function') c.on('error', (err) => console.error('[mail] proba imap:', err.code || 'eroare'))
  await c.connect()
  await c.logout()
}

// §5 export
module.exports = {
  setConnector,
  imapConfig,
  smtpConfig,
  run,
  withFolder,
  invalidateSelection,
  drop,
  closeAll,
  probe,
  isNetworkError,
}
