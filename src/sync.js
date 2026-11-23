'use strict'
/* MAP
 * §1 imports & config                   L11-L30
 * §2 pornire, oprire, declansare        L31-L64
 * §3 planificare per user               L65-L90
 * §4 sincronizare cont                  L91-L141
 * §5 mesaje noi (reguli, calendar, contacte) L142-L196
 * §6 export                             L197-L198
 */

// §1 imports & config
const store = require('./store')
const pool = require('./pool')
const rules = require('./rules')
const detect = require('./detect')
const common = require('./api-common')
const apiRules = require('./api-rules')
const calendar = require('./api-calendar')
const messages = require('./api-messages')

const TICK_MS = 15 * 1000
const AUTH_BACKOFF_MS = 15 * 60 * 1000
const MAX_NEW = 200 // mesaje noi procesate pe ciclu; restul la ciclul urmator
const RAW_MAX = 2 * 1024 * 1024
const CAL_METHODS = ['REQUEST', 'PUBLISH']

let timer = null
const running = new Set() // `${user}|${accountId}`
const lastAttempt = new Map() // `${user}|${accountId}` → ms

// §2 pornire, oprire, declansare
function log(err) {
  console.error('[mail] sync:', err && (err.code || err.name))
}

function start() {
  if (timer) return
  timer = setInterval(() => runOnce({}).catch(log), TICK_MS)
  timer.unref()
  setTimeout(() => runOnce({}).catch(log), 2000).unref()
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

/** POST /api/mail/sync: ciclu imediat, fara asteptare. */
function trigger(user, accountId) {
  runOnce({ user, account: accountId, force: true }).catch(log)
}

/** Un ciclu complet (testele il asteapta); force ignora pollSeconds, nu si backoff-ul de autentificare. */
async function runOnce({ user, account, force } = {}) {
  const users = user ? [user] : store.listUsers()
  for (const u of users) {
    try {
      await syncUser(u, { account, force: !!force })
    } catch (err) {
      log(err)
    }
  }
}

// §3 planificare per user
function isDue(key, s, pollMs, force, now) {
  if (running.has(key)) return false
  // Parola gresita: max o incercare la 15 minute, ca sa nu blocheze serverul contul.
  if (s.authFailAt && now - s.authFailAt < AUTH_BACKOFF_MS) return false
  if (force) return true
  const last = lastAttempt.get(key)
  return !last || now - last >= pollMs
}

async function syncUser(user, { account, force }) {
  const accounts = store.read(user, 'accounts.json').accounts.filter((a) => !account || a.id === account)
  if (!accounts.length) return
  const pollMs = store.getProfile(user).settings.pollSeconds * 1000
  const states = store.read(user, 'sync.json')
  const now = Date.now()
  const due = accounts.filter((acc) => isDue(`${user}|${acc.id}`, states[acc.id] || {}, pollMs, force, now))
  if (!due.length) return
  let idx = 0
  const workers = Array.from({ length: Math.min(4, due.length) }, async () => {
    while (idx < due.length) await syncAccount(user, due[idx++]).catch(log)
  })
  await Promise.all(workers)
}

// §4 sincronizare cont
async function saveState(user, accountId, patch) {
  await store.update(user, 'sync.json', (s) => {
    // Contul poate fi sters intre timp; nu-i reinviem starea.
    if (!store.read(user, 'accounts.json').accounts.some((a) => a.id === accountId)) return
    s[accountId] = { ...(s[accountId] || {}), ...patch }
    if (patch.authFailAt === null) delete s[accountId].authFailAt
  })
}

async function syncAccount(user, acc) {
  const key = `${user}|${acc.id}`
  running.add(key)
  lastAttempt.set(key, Date.now())
  try {
    if (!acc.password) {
      await saveState(user, acc.id, { error: 'Lipseste parola contului' })
      return
    }
    const prev = store.read(user, 'sync.json')[acc.id] || {}
    let st = await pool.run(user, acc.id, (c) => c.status('INBOX'))
    const firstRun = !prev.uidvalidity || prev.uidvalidity !== st.uidvalidity || typeof prev.lastUid !== 'number'
    let lastUid = prev.lastUid
    if (firstRun) {
      // Prima rulare (sau UIDVALIDITY schimbat): doar marcam pozitia, fara reguli pe istoric.
      lastUid = st.uidnext ? st.uidnext - 1 : await maxUid(user, acc.id)
    } else if (!st.uidnext || st.uidnext - 1 > lastUid) {
      const res = await processNew(user, acc, lastUid)
      lastUid = res.lastUid
      if (res.changed) {
        st = await pool.run(user, acc.id, (c) => c.status('INBOX'))
        common.invalidate(user, acc.id)
      }
    }
    const unseen = st.unseen || 0
    await saveState(user, acc.id, { uidvalidity: st.uidvalidity, lastUid: Math.max(0, lastUid || 0), lastSync: new Date().toISOString(), unseen, error: null, authFailAt: null })
    if (prev.unseen !== unseen) common.invalidate(user, acc.id)
  } catch (err) {
    const human = common.humanError(err)
    console.error(`[mail] sync ${user}/${acc.id}: ${human}`)
    await saveState(user, acc.id, { error: human, ...(err.code === 'AUTH' ? { authFailAt: Date.now() } : {}) })
  } finally {
    running.delete(key)
  }
}

async function maxUid(user, accountId) {
  const uids = await pool.withFolder(user, accountId, 'INBOX', (c) => c.search('ALL'))
  return uids.length ? Math.max(...uids) : 0
}

// §5 mesaje noi (reguli, calendar, contacte)
/** Posibila invitatie/programare: merita descarcat corpul. */
function maybeCalendar(h) {
  const env = h.envelope || {}
  const text = `${env.subject || ''} ${h.preview || ''}`
  return !!h.hasAttachments || detect.hasKeyword(text) || /\binvit/i.test(text)
}

function calendarFrom(parsed, subject) {
  const ics = messages.icsEvents(parsed)
  if (ics.length) {
    const ok = ics.filter((e) => CAL_METHODS.includes(String(e.method || '').toUpperCase()))
    // ICS de tip CANCEL/REPLY: nu ghicim din text peste el.
    return { status: 'invited', events: ok.map((e) => ({ title: e.summary || subject, start: e.start, end: e.end, allDay: !!e.allDay, location: e.location || '', notes: e.description || '' })) }
  }
  return { status: 'detected', events: detect.detect({ subject, text: parsed.text, html: parsed.html, headers: parsed.headers }).slice(0, 1) }
}

async function processNew(user, acc, lastUid) {
  const profile = store.getProfile(user)
  const active = profile.rules.filter((r) => r.enabled && (r.account === '*' || r.account === acc.id))
  const bodyRules = rules.needsBody(active)
  const autoCal = profile.settings.autoCalendar !== false
  const res = await pool.withFolder(user, acc.id, 'INBOX', async (c) => {
    const all = (await c.search(`UID ${lastUid + 1}:*`)).filter((u) => u > lastUid).sort((a, b) => a - b)
    if (!all.length) return { lastUid, changed: false, found: [], contacts: [] }
    const uids = all.slice(0, MAX_NEW)
    const headers = (await c.fetchHeaders(uids)).sort((a, b) => a.uid - b.uid)
    const batch = rules.newBatch()
    const found = []
    const contacts = []
    for (const h of headers) {
      const wantCal = autoCal && maybeCalendar(h)
      const parsed = bodyRules || wantCal ? await apiRules.fetchParsed(c, h.uid) : null
      const msg = apiRules.ruleMsg(h, parsed)
      rules.addToBatch(batch, rules.evaluate(active, msg, acc.id), { ...msg, body: '' })
      if (wantCal && parsed) {
        const cal = calendarFrom(parsed, msg.subject)
        if (cal.events.length) found.push({ ...cal, uid: h.uid, messageId: msg.messageId, subject: msg.subject })
      }
      for (const a of msg.from) if (a.address && a.address.toLowerCase() !== acc.email.toLowerCase()) contacts.push(a)
    }
    const destOf = await rules.executeBatch(c, batch, { user, accountId: acc.id, folder: 'INBOX' })
    const gone = new Set(batch.expunge)
    for (const f of found) f.folder = gone.has(f.uid) ? null : destOf.get(f.uid) || 'INBOX'
    return { lastUid: Math.max(...uids), changed: batch.count > 0, found: found.filter((f) => f.folder), contacts }
  })
  for (const f of res.found) {
    const source = { account: acc.id, folder: f.folder, uid: f.folder === 'INBOX' ? f.uid : null, messageId: f.messageId, subject: f.subject }
    await calendar.addEvents(user, f.events, source, f.status).catch(log)
  }
  await common.addContacts(user, res.contacts).catch(log)
  return res
}

// §6 export
module.exports = { start, stop, trigger, runOnce }
