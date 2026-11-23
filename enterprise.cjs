'use strict'

const { app, dialog, shell } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const detail = "We build and deploy a paid Enterprise edition to order. Examples of what we can develop and extend for your organization are listed below.\n\n• Central control for account policies and signatures across managed workstations.\n• Integration with ticketing and CRM systems for selected messages.\n• Shared mailbox assignment and role-based access, subject to provider support.\n\nFor an Enterprise edition or custom development, contact us at verobots.eu or olarian.com."
const sites = ['https://verobots.eu/', 'https://olarian.com/']
let checking = false

async function showEnterprise(window) {
  if (checking || window.isDestroyed()) return
  checking = true
  const marker = path.join(app.getPath('userData'), 'enterprise-intro-v1')
  try {
    try { await fs.access(marker); return } catch (error) { if (error.code !== 'ENOENT') throw error }
    const { response } = await dialog.showMessageBox(window, {
      type: 'info', title: "NexMail", message: 'Enterprise edition',
      detail, buttons: ['Continue', 'verobots.eu', 'olarian.com'], defaultId: 0, cancelId: 0,
    })
    await fs.writeFile(marker, 'seen\n')
    if (sites[response - 1]) await shell.openExternal(sites[response - 1])
  } catch (error) {
    console.warn('Enterprise introduction:', error.code || 'unavailable')
  } finally { checking = false }
}

module.exports = { showEnterprise }
