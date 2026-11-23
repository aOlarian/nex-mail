'use strict'
/* MAP
 * §1 Desktop initialization and request identity L8-L28
 * §2 Window and lifecycle L30-L75
 */

// §1 Desktop initialization and request identity
const { app, BrowserWindow, dialog, session } = require('electron')
const { randomBytes, timingSafeEqual } = require('node:crypto')
const path = require('node:path')
const service = require('./serviciu')

const header = 'x-nexmail-session'
const secret = randomBytes(32).toString('hex')
let server = null
let window = null
let closing = false

function identity(req) {
  const address = server?.address()
  if (!address || req.headers.host !== `127.0.0.1:${address.port}`) return null
  const expectedOrigin = `http://${req.headers.host}`
  if (req.headers.origin && req.headers.origin !== expectedOrigin) return null
  const offered = req.headers[header]
  if (typeof offered !== 'string' || !/^[a-f0-9]{64}$/.test(offered)) return null
  return timingSafeEqual(Buffer.from(offered, 'hex'), Buffer.from(secret, 'hex')) ? 'local' : null
}

// §2 Window and lifecycle
async function openMail() {
  process.env.NEX_MAIL_DATA = path.join(app.getPath('userData'), 'mail')
  server = await service.start({ identity })
  const origin = `http://127.0.0.1:${server.address().port}`
  const browserSession = session.fromPartition('nexmail')
  browserSession.setPermissionRequestHandler((_webContents, _permission, respond) => respond(false))
  browserSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, respond) => {
    const mainFrame = details.resourceType === 'mainFrame' || (details.frame && details.frame === details.frame.top)
    const sameWindow = details.webContentsId === window?.webContents.id
    if (mainFrame && sameWindow) details.requestHeaders[header] = secret
    respond({ requestHeaders: details.requestHeaders })
  })

  window = new BrowserWindow({
    title: 'NexMail', width: 1280, height: 800, minWidth: 800, minHeight: 600,
    webPreferences: { session: browserSession, contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault()
  })
  await window.loadURL(`${origin}/mail/`)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => window?.focus())
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (closing || !server) return
    event.preventDefault()
    closing = true
    service.stop(server).then(() => app.quit(), (error) => {
      console.error('[nexmail] shutdown failed', error.message)
      app.exit(1)
    })
  })
  app.whenReady().then(openMail).catch((error) => {
    dialog.showErrorBox('NexMail', error.message)
    app.quit()
  })
}
