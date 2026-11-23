'use strict'
/* MAP
 * §1 imports & reguli de validare       L9-L32
 * §2 setari                             L33-L73
 * §3 categorii, semnaturi, grupuri      L74-L147
 * §4 rute                               L148-L157
 */

// §1 imports & reguli de validare
const store = require('./store')
const { httpError, intIn, str, invalidate } = require('./api-common')

const ENUMS = {
  theme: [
    'light', 'dark', 'blue', 'purple', 'green', 'system', 'nex',
    'azur', 'ema-dark', 'ema-light', 'amber-dark', 'amber-light', 'neon-horizon',
    'aero-glass', 'windows-xp', 'putty-terminal', 'executive-slate', 'polar-blueprint',
    'cinder-rose', 'moss-paper', 'plum-orchard-dusk', 'linen-and-sea-glass',
  ],
  density: ['comfortable', 'compact'],
  fontSize: ['xsmall', 'small', 'normal', 'large', 'xlarge', 'xxlarge'],
  readingPane: ['right', 'bottom'],
  showImages: ['ask', 'always'],
}
const RANGES = {
  markReadSeconds: [0, 30],
  pollSeconds: [60, 3600],
  pageSize: [25, 200],
}
const COLOR_RE = /^#[0-9a-f]{6}$/i
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/

// §2 setari
function cleanAllInboxes(curVal, val) {
  if (!val || typeof val !== 'object') throw httpError(400, 'Valoare invalida pentru allInboxes')
  const prev = curVal && typeof curVal === 'object' ? curVal : { color: '', excluded: [] }
  let color = prev.color || ''
  if (val.color !== undefined) {
    color = val.color === '' || val.color == null ? '' : String(val.color).trim().toLowerCase()
    if (color && !COLOR_RE.test(color)) throw httpError(400, 'Culoare invalida pentru allInboxes')
  }
  let excluded = Array.isArray(prev.excluded) ? prev.excluded : []
  if (val.excluded !== undefined) {
    if (!Array.isArray(val.excluded)) throw httpError(400, 'Lista excluded invalida')
    excluded = [...new Set(val.excluded.map((x) => String(x || '').trim()).filter((x) => ID_RE.test(x)))].slice(0, 200)
  }
  return { color, excluded }
}

/** Setari partiale: chei necunoscute ignorate, valori in afara listei/intervalului refuzate sau limitate. */
function cleanSettings(current, input) {
  const out = { ...current }
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (input[k] === undefined) continue
    if (!allowed.includes(input[k])) throw httpError(400, `Valoare invalida pentru ${k}`)
    out[k] = input[k]
  }
  for (const [k, [min, max]] of Object.entries(RANGES)) {
    if (input[k] === undefined) continue
    out[k] = intIn(input[k], current[k], min, max)
  }
  if (input.autoCalendar !== undefined) out.autoCalendar = !!input.autoCalendar
  if (input.allInboxes !== undefined) out.allInboxes = cleanAllInboxes(current.allInboxes, input.allInboxes)
  return out
}

async function postSettings({ user, body }) {
  const cur = store.getProfile(user).settings
  const saved = await store.setProfile(user, 'settings', cleanSettings(cur, body || {}))
  if (body && body.allInboxes !== undefined) invalidate(user)
  return saved
}

// §3 categorii, semnaturi, grupuri
function cleanCategories(list) {
  if (!Array.isArray(list)) throw httpError(400, 'Lipseste lista de categorii')
  if (list.length > 100) throw httpError(400, 'Prea multe categorii')
  const seen = new Set()
  return list.map((c) => {
    const name = str(c && c.name, 60).trim()
    if (!name) throw httpError(400, 'Categoria are nevoie de nume')
    if (!COLOR_RE.test((c && c.color) || '')) throw httpError(400, `Culoare invalida pentru „${name}”`)
    let id = c.id && ID_RE.test(c.id) ? c.id : store.newId('c')
    if (seen.has(id)) id = store.newId('c')
    seen.add(id)
    return { id, name, color: c.color.toLowerCase() }
  })
}

function cleanSignatures(list) {
  if (!Array.isArray(list)) throw httpError(400, 'Lipseste lista de semnaturi')
  if (list.length > 50) throw httpError(400, 'Prea multe semnaturi')
  const seen = new Set()
  return list.map((s) => {
    const html = typeof (s && s.html) === 'string' ? s.html : ''
    if (html.length > 512 * 1024) throw httpError(400, 'Semnatura e prea mare (max 512 KB)')
    let id = s.id && ID_RE.test(s.id) ? s.id : store.newId('s')
    if (seen.has(id)) id = store.newId('s')
    seen.add(id)
    return { id, name: str(s.name, 80).trim() || 'Semnatura', html }
  })
}

async function postCategories({ user, body }) {
  const categories = cleanCategories(body.categories)
  const valid = new Set(categories.map((c) => c.id))
  const saved = await store.setProfile(user, 'categories', categories)
  // Categorie stearsa → scoasa si de pe mesaje, ca filtrele sa nu arate id-uri orfane.
  await store.update(user, 'meta.json', (meta) => {
    for (const [k, m] of Object.entries(meta)) {
      if (!Array.isArray(m.categories)) continue
      m.categories = m.categories.filter((id) => valid.has(id))
      if (!m.categories.length && !m.task) delete meta[k]
    }
  })
  return saved
}

async function postSignatures({ user, body }) {
  return store.setProfile(user, 'signatures', cleanSignatures(body.signatures))
}

function cleanAccountGroups(list) {
  if (!Array.isArray(list)) throw httpError(400, 'Missing account groups list')
  if (list.length > 50) throw httpError(400, 'Too many account categories')
  const seen = new Set()
  return list.map((g) => {
    const name = str(g && g.name, 60).trim()
    if (!name) throw httpError(400, 'Category needs a name')
    const color = COLOR_RE.test((g && g.color) || '') ? g.color.toLowerCase() : '#0078d4'
    let id = g.id && ID_RE.test(g.id) ? g.id : store.newId('g')
    if (seen.has(id)) id = store.newId('g')
    seen.add(id)
    return { id, name, color, collapsed: !!g.collapsed }
  })
}

async function postAccountGroups({ user, body }) {
  const groups = cleanAccountGroups(body && body.groups)
  const valid = new Set(groups.map((g) => g.id))
  const saved = await store.setProfile(user, 'accountGroups', groups)
  await store.update(user, 'accounts.json', (data) => {
    for (const a of data.accounts) if (a.groupId && !valid.has(a.groupId)) delete a.groupId
  })
  return saved
}

// §4 rute
module.exports = {
  cleanSettings,
  routes: {
    'POST settings': postSettings,
    'POST categories': postCategories,
    'POST signatures': postSignatures,
    'POST account-groups': postAccountGroups,
  },
}
