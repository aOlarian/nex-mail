'use strict'
/* MAP
 * §1 imports & dependinte injectabile   L11-L30
 * §2 stare si necitite                  L31-L58
 * §3 autoconfig                         L59-L136
 * §4 test cont                          L137-L169
 * §5 salvare, stergere, sync            L170-L199
 * §6 rute                               L200-L214
 */

// §1 imports & dependinte injectabile
const dns = require('dns')
const net = require('net')
const store = require('./store')
const pool = require('./pool')
const sync = require('./sync')
const common = require('./api-common')
const { httpError } = common

const PROBE_MS = 3000
const deps = {
  resolveMx: defaultResolveMx,
  probe: tcpProbe,
}

/** Teste: { resolveMx(domain) → [{exchange,priority}], probe(host, port) → bool }. */
function setAutoconfigDeps(d) {
  Object.assign(deps, d)
}

// §2 stare si necitite
function unreadOf(user) {
  const s = store.read(user, 'sync.json')
  const byAccount = {}
  let total = 0
  for (const acc of store.read(user, 'accounts.json').accounts) {
    const n = Number((s[acc.id] && s[acc.id].unseen) || 0)
    byAccount[acc.id] = n
    total += n
  }
  return { total, byAccount }
}

function getState({ user }) {
  const s = store.read(user, 'sync.json')
  const profile = store.getProfile(user)
  return {
    user,
    accounts: store.read(user, 'accounts.json').accounts.map((a) => store.publicAccount(a, s[a.id])),
    settings: profile.settings,
    categories: profile.categories,
    signatures: profile.signatures,
    accountGroups: profile.accountGroups,
    filteredFolders: profile.filteredFolders,
    unread: unreadOf(user),
  }
}

// §3 autoconfig
/** Rezolvorul de sistem (c-ares) poate refuza pe Windows; folosim servere publice explicit. */
async function defaultResolveMx(domain) {
  const r = new dns.promises.Resolver({ timeout: 2000, tries: 1 })
  r.setServers(['1.1.1.1', '8.8.8.8'])
  try {
    return await r.resolveMx(domain)
  } catch (err) {
    return dns.promises.resolveMx(domain)
  }
}

function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const done = (ok) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(PROBE_MS, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

const KNOWN = [
  { re: /^(gmail\.com|googlemail\.com)$/, mx: /(^|\.)(google|googlemail)\.com$/, imap: ['imap.gmail.com', 993, true], smtp: ['smtp.gmail.com', 465, true] },
  { re: /^(outlook|hotmail|live|msn)\.[a-z.]+$/, mx: /\.outlook\.com$/, imap: ['outlook.office365.com', 993, true], smtp: ['smtp.office365.com', 587, false] },
  { re: /^(yahoo|ymail)\.[a-z.]+$/, mx: /yahoodns\.net$/, imap: ['imap.mail.yahoo.com', 993, true], smtp: ['smtp.mail.yahoo.com', 465, true] },
]

function server([host, port, secure]) {
  return { host, port, secure }
}

/** Primul candidat (in ordinea listei) care raspunde; probele ruleaza in paralel. */
async function firstAlive(cands) {
  const results = await Promise.all(cands.map((c) => Promise.resolve(deps.probe(c.host, c.port)).catch(() => false)))
  const i = results.findIndex(Boolean)
  return i >= 0 ? cands[i] : null
}

async function autoconfig({ body }) {
  const email = String(body.email || '').trim().toLowerCase()
  const domain = email.split('@')[1] || ''
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw httpError(400, 'Adresa de email invalida')
  const known = KNOWN.find((k) => k.re.test(domain))
  if (known) return { imap: server(known.imap), smtp: server(known.smtp), guessed: true }

  let mxHosts = []
  try {
    const mx = await deps.resolveMx(domain)
    mxHosts = (mx || []).sort((a, b) => a.priority - b.priority).map((m) => String(m.exchange).toLowerCase())
  } catch (err) {
    // Fara MX raman candidatii dupa nume; nu e o eroare pentru om.
    mxHosts = []
  }
  const hosted = KNOWN.find((k) => mxHosts.some((h) => k.mx.test(h)))
  if (hosted) return { imap: server(hosted.imap), smtp: server(hosted.smtp), guessed: true }

  const uniq = (list) => [...new Set(list.filter(Boolean))]
  const imapHosts = uniq([`mail.${domain}`, `imap.${domain}`, ...mxHosts])
  const smtpHosts = uniq([`mail.${domain}`, `smtp.${domain}`, ...mxHosts])
  const [imap, smtpHit] = await Promise.all([
    firstAlive(imapHosts.map((host) => ({ host, port: 993, secure: true }))),
    firstAlive(smtpHosts.flatMap((host) => [
      { host, port: 465, secure: true },
      { host, port: 587, secure: false },
    ])),
  ])
  return {
    imap: imap || { host: `mail.${domain}`, port: 993, secure: true },
    smtp: smtpHit || { host: `mail.${domain}`, port: 465, secure: true },
    guessed: true,
    reachable: { imap: !!imap, smtp: !!smtpHit },
  }
}

// §4 test cont
function candidate(body) {
  const host = (s) => String((s && s.host) || '').trim().toLowerCase()
  if (!host(body.imap) || !host(body.smtp)) throw httpError(400, 'Completeaza serverele IMAP si SMTP')
  return {
    email: String(body.email || ''),
    user: String(body.user || body.email || ''),
    imap: { host: host(body.imap), port: Number(body.imap.port) || 993, secure: body.imap.secure !== false },
    smtp: { host: host(body.smtp), port: Number(body.smtp.port) || 465, secure: body.smtp.secure !== false },
    insecureTls: body.insecureTls === true,
  }
}

async function outcome(promise) {
  try {
    await promise
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: common.humanError(err) }
  }
}

async function testAccount({ user, body }) {
  const acc = candidate(body)
  let pass = typeof body.password === 'string' ? body.password : ''
  if (!pass && body.id) pass = store.getPassword(user, body.id)
  const [imap, smtp] = await Promise.all([
    outcome(pool.probe(acc, pass)),
    outcome(Promise.resolve().then(() => common.smtp().verify(pool.smtpConfig(acc, pass)))),
  ])
  return { imap, smtp }
}

// §5 salvare, stergere, sync
async function saveAccount({ user, body }) {
  const saved = await store.saveAccount(user, body)
  pool.drop(user, saved.id)
  common.invalidate(user, saved.id)
  return store.publicAccount(saved, store.read(user, 'sync.json')[saved.id])
}

async function deleteAccount({ user, body }) {
  const ok = await store.deleteAccount(user, String(body.id || ''))
  if (!ok) throw httpError(404, 'Account not found')
  pool.drop(user, body.id)
  common.invalidate(user, body.id)
  return { ok: true }
}

async function reorderAccounts({ user, body }) {
  const items = Array.isArray(body && body.order) ? body.order : Array.isArray(body && body.ids) ? body.ids : null
  if (!items) throw httpError(400, 'Missing account order list')
  const s = store.read(user, 'sync.json')
  const list = await store.reorderAccounts(user, items)
  return list.map((a) => store.publicAccount(a, s[a.id]))
}

function postSync({ user, body }) {
  if (body.account) common.requireAccount(user, body.account)
  sync.trigger(user, body.account || null)
  return { ok: true }
}

// §6 rute
module.exports = {
  setAutoconfigDeps,
  unreadOf,
  routes: {
    'GET state': getState,
    'GET unread': ({ user }) => ({ total: unreadOf(user).total }),
    'POST accounts/autoconfig': autoconfig,
    'POST accounts/test': testAccount,
    'POST accounts/save': saveAccount,
    'POST accounts/reorder': reorderAccounts,
    'POST accounts/delete': deleteAccount,
    'POST sync': postSync,
  },
}
