'use strict'
/* MAP
 * §1 cheia masinii                      L9-L32
 * §2 AES-256-GCM                        L33-L47
 * §3 export                             L48-L54
 */
// Separat din store.js (limita de 300 linii). dataRoot vine de la store, evaluat la fiecare apel.
module.exports = function storeCrypto(dataRoot) {
  // §1 cheia masinii
  const fs = require('fs')
  const path = require('path')
  const crypto = require('crypto')
  let cachedKey = null
  let cachedKeyRoot = null
  /** Cheia se creeaza o singura data ('wx'); daca exista, se citeste. Regenerarea ar pierde toate parolele. */
  function machineKey() {
    const root = dataRoot()
    if (cachedKey && cachedKeyRoot === root) return cachedKey
    const file = path.join(root, 'key.bin')
    fs.mkdirSync(root, { recursive: true })
    try {
      fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const key = fs.readFileSync(file)
    if (key.length !== 32) throw new Error('key.bin are lungime gresita; refuz sa o inlocuiesc')
    cachedKey = key
    cachedKeyRoot = root
    return key
  }

  // §2 AES-256-GCM
  function encrypt(plain) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', machineKey(), iv)
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
  }

  function decrypt(box) {
    if (!box || !box.iv || !box.tag || typeof box.data !== 'string') return ''
    const decipher = crypto.createDecipheriv('aes-256-gcm', machineKey(), Buffer.from(box.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8')
  }

  // §3 export
  function forgetKey() {
    cachedKey = null
    cachedKeyRoot = null
  }
  return { machineKey, encrypt, decrypt, forgetKey }
}
