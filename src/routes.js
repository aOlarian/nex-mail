'use strict'
/* MAP
 * §1 imports                            L8-L22
 * §2 tabela de rute                     L23-L38
 * §3 dispatch                           L39-L71
 */

// §1 imports
const common = require('./api-common')
const modules = [
  require('./api-accounts'),
  require('./api-settings'),
  require('./api-folders'),
  require('./api-messages'),
  require('./api-actions'),
  require('./api-compose'),
  require('./api-rules'),
  require('./api-calendar'),
  require('./api-filtered'),
  require('./api-search'),
]

// §2 tabela de rute
// Fiecare modul exporta routes: { 'GET state': fn, 'POST accounts/save': fn, ... }
const table = new Map()
for (const m of modules) {
  for (const [key, fn] of Object.entries(m.routes || {})) {
    if (table.has(key)) throw new Error('ruta dublata: ' + key)
    table.set(key, fn)
  }
}

function hasRoute(method, sub) {
  return table.has(`${method} ${sub}`)
}

const PREFIX = '/api/mail/'

// §3 dispatch
/**
 * ctx = { user, query, body, req, res }. Handlerul intoarce obiectul JSON
 * sau scrie singur raspunsul (binar) si intoarce undefined.
 */
async function dispatch(method, pathname, ctx, sendJson) {
  const sub = pathname.slice(PREFIX.length)
  const fn = table.get(`${method} ${sub}`)
  if (!fn) {
    const other = method === 'GET' ? 'POST' : 'GET'
    if (table.has(`${other} ${sub}`)) return sendJson(405, { eroare: 'Method not allowed' })
    return sendJson(404, { eroare: 'Unknown route' })
  }
  try {
    const out = await fn(ctx)
    if (ctx.res.headersSent || ctx.res.writableEnded) return
    sendJson(200, out === undefined ? { ok: true } : out)
  } catch (err) {
    const status = common.statusFor(err)
    // Doar codul si ruta in log: mesajele serverelor nu ajung in jurnal cu continut de mesaj.
    if (status >= 500) {
      const where = err.human ? err.message : `${err.name || 'Error'} ${(String(err.stack || '').split('\n')[1] || '').trim()}`
      console.error(`[mail] ${method} ${sub} → ${status} ${err.code || ''} ${where}`)
    }
    if (ctx.res.headersSent) {
      ctx.res.destroy()
      return
    }
    sendJson(status, { eroare: common.humanError(err) })
  }
}

module.exports = { dispatch, hasRoute, PREFIX }
