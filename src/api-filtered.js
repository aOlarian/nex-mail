'use strict'
/* MAP
 * §1 imports & helpers                  L8-L14
 * §2 foldere globale                    L15-L58
 * §3 rute                               L59-L65
 */

// §1 imports & helpers
const store = require('./store')
const localStore = require('./local-store')
const { httpError, str } = require('./api-common')

const COLOR_RE = /^#[0-9a-f]{6}$/i

// §2 foldere globale
function getFolders({ user }) {
  return { folders: localStore.getFolders(user) }
}

async function postFolders({ user, body }) {
  const b = body || {}
  if (Array.isArray(b.folders)) {
    return { folders: await localStore.saveFolders(user, b.folders) }
  }
  if (b.action === 'create') {
    const created = await localStore.createFolder(user, b.name, b.color)
    return { folder: created, folders: localStore.getFolders(user) }
  }
  if (b.action === 'rename') {
    const id = str(b.id, 60).trim()
    const list = store.getProfile(user).filteredFolders
    const target = list.find((f) => f.id === id)
    if (!target) throw httpError(404, 'Filtered folder not found')
    if (b.name !== undefined) {
      const name = str(b.name, 60).trim()
      if (!name) throw httpError(400, 'Folder name required')
      target.name = name
    }
    if (b.color !== undefined) {
      if (b.color && COLOR_RE.test(b.color)) target.color = b.color.toLowerCase()
      else delete target.color
    }
    return { folders: await localStore.saveFolders(user, list) }
  }
  if (b.action === 'delete') {
    const id = str(b.id, 60).trim()
    const list = store.getProfile(user).filteredFolders
    const target = list.find((f) => f.id === id)
    if (!target) throw httpError(404, 'Filtered folder not found')
    if (target.system) throw httpError(400, 'Built-in filter folders cannot be deleted (you can rename them)')
    const next = list.filter((f) => f.id !== id)
    const folders = await localStore.saveFolders(user, next)
    await localStore.removeFolderData(user, id)
    return { folders }
  }
  throw httpError(400, 'Unknown folder action')
}

// §3 rute
module.exports = {
  routes: {
    'GET filtered/folders': getFolders,
    'POST filtered/folders': postFolders,
  },
}
