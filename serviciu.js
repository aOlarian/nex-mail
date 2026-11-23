'use strict'
/* MAP
 * §1 imports & config                   L10-L28
 * §2 utilitare HTTP                     L30-L76
 * §3 fisiere statice web/               L78-L107
 * §4 server                             L109-L171
 * §5 pornire (main)                     L173-L188
 */

// §1 imports & config
const http = require('http')
const fs = require('fs')
const path = require('path')
const store = require('./src/store')

const WEB_DIR = path.join(__dirname, 'web')
const MAX_BODY = 40 * 1024 * 1024
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/

// §2 utilitare HTTP
function sendJson(res, status, obj) {
  if (res.headersSent) return
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > MAX_BODY) return reject(Object.assign(new Error('Mesajul depaseste 40 MB'), { status: 413, human: true }))
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Mesajul depaseste 40 MB'), { status: 413, human: true }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!size) return resolve({})
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {})
      } catch (err) {
        reject(Object.assign(new Error('Corp JSON invalid'), { status: 400, human: true, cause: err }))
      }
    })
    req.on('error', reject)
  })
}

// §3 fisiere statice web/
function serveStatic(res, file) {
  const ext = path.extname(file).toLowerCase()
  if (!MIME[ext]) return sendJson(res, 404, { eroare: 'Fisier inexistent' })
  const full = path.join(WEB_DIR, file)
  fs.readFile(full, (err, data) => {
    if (err) return sendJson(res, 404, { eroare: 'Fisier inexistent' })
    res.writeHead(200, {
      'content-type': MIME[ext],
      'content-length': data.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(data)
  })
}

function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { eroare: 'Metoda nepermisa' })
  if (pathname === '/mail' || pathname === '/mail/') return serveStatic(res, 'index.html')
  const m = /^\/mail\/assets\/([^/]+)$/.exec(pathname)
  let name = null
  try {
    name = m ? decodeURIComponent(m[1]) : null
  } catch (err) {
    name = null // URL cu procent invalid → tratat ca inexistent
  }
  if (!name || !ASSET_RE.test(name) || name.includes('..')) return sendJson(res, 404, { eroare: 'Fisier inexistent' })
  return serveStatic(res, name)
}

// §4 server
function createServer(identity) {
  if (typeof identity !== 'function') throw new TypeError('A request identity resolver is required')
  const routes = require('./src/routes')
  return http.createServer(async (req, res) => {
    const user = identity(req)
    if (!store.validUser(user)) return sendJson(res, 401, { eroare: 'Utilizator neautentificat' })
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch (err) {
      return sendJson(res, 400, { eroare: 'URL invalid' })
    }
    const pathname = url.pathname
    if (!pathname.startsWith(routes.PREFIX)) {
      if (pathname === '/mail' || pathname.startsWith('/mail/')) return handleStatic(req, res, pathname)
      return sendJson(res, 404, { eroare: 'Ruta necunoscuta' })
    }
    let body = {}
    if (req.method === 'POST') {
      try {
        body = await readBody(req)
      } catch (err) {
        return sendJson(res, err.status || 400, { eroare: err.human ? err.message : 'Corp invalid' })
      }
    }
    const query = Object.fromEntries(url.searchParams)
    try {
      store.ensureUser(user)
      await routes.dispatch(req.method, pathname, { user, query, body, req, res }, (s, o) => sendJson(res, s, o))
    } catch (err) {
      console.error('[mail] cerere esuata:', err.name, err.code || '')
      sendJson(res, 500, { eroare: 'Eroare interna' })
    }
  })
}

/** Porneste serviciul; opts.port (0 = liber, pentru teste), opts.sync=false opreste bucla de fundal. */
function start(opts = {}) {
  const port = opts.port ?? 0
  const server = createServer(opts.identity)
  server.requestTimeout = 10 * 60 * 1000
  const sync = require('./src/sync')
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      if (opts.sync !== false) sync.start()
      resolve(server)
    })
  })
}

async function stop(server) {
  require('./src/sync').stop()
  await require('./src/pool').closeAll()
  if (!server) return
  const closed = new Promise((r) => server.close(() => r()))
  server.closeAllConnections()
  await closed
}

module.exports = { start, stop, createServer }
