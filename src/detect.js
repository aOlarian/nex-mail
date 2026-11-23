'use strict'
/* MAP
 * §1 constante (luni, cuvinte-cheie)    L11-L40
 * §2 normalizare text                   L41-L79
 * §3 fus orar Europe/Bucharest          L80-L105
 * §4 gasire date                        L106-L137
 * §5 gasire ora si locatie              L138-L189
 * §6 filtru bulk & API public detect()  L190-L252
 */

// §1 constante (luni, cuvinte-cheie)
const TZ = 'Europe/Bucharest'
const MAX_TEXT = 20000

const MONTHS = {
  ianuarie: 1, ian: 1, january: 1, jan: 1,
  februarie: 2, feb: 2, february: 2,
  martie: 3, mar: 3, march: 3,
  aprilie: 4, apr: 4, april: 4,
  mai: 5, may: 5,
  iunie: 6, iun: 6, june: 6, jun: 6,
  iulie: 7, iul: 7, july: 7, jul: 7,
  august: 8, aug: 8,
  septembrie: 9, sept: 9, sep: 9, september: 9,
  octombrie: 10, oct: 10, october: 10,
  noiembrie: 11, noi: 11, nov: 11, november: 11,
  decembrie: 12, dec: 12, december: 12,
}
// Cele lungi primele, ca „noiembrie” sa nu fie prins ca „noi”.
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')
// Luna inaintea zilei e doar engleza; „mai 20 de minute” nu e o data.
const MONTH_EN_ALT = 'january|february|march|april|may|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec'

const KEYWORD_RE = new RegExp(
  '\\b(?:' +
    ['programare', 'programat', 'intalnire', 'sedinta', 'consultatie', 'interviu', 'rezervare', 'appointment', 'meeting', 'interview', 'booking', 'reservation', 'webinar', 'invitatie', 'eveniment'].join('|') +
    '|(?:(?:quick|video|phone|audio|zoom|teams|meet|intro|discovery|screening|conference|conf|scheduled|schedule a|book a|calendar|\\d+\\s*-?\\s*min(?:ute)?)\\s+call|call\\s+with)\\b)',
)

// §2 normalizare text
/** Fara diacritice, lowercase (comparatiile din reguli si cautari). */
function norm(s) {
  return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/** Ca norm(), dar pastreaza lungimea, ca pozitiile gasite sa indice in textul original. */
function normSameLen(s) {
  let out = ''
  for (const ch of String(s)) {
    const n = ch.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    out += n.length === ch.length ? n : ch.length === 1 ? (n[0] || ' ') : ch
  }
  return out
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }

function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]{0,2000}>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => {
      const k = e.toLowerCase()
      if (ENTITIES[k]) return ENTITIES[k]
      if (k[0] === '#') {
        const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '
      }
      return m
    })
    .replace(/[ \t ]+/g, ' ')
}

function hasKeyword(text) {
  return KEYWORD_RE.test(norm(text))
}

// §3 fus orar Europe/Bucharest
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })

function offsetAt(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000
}

/** Ora de perete din Bucuresti → milisecunde UTC (corect si la schimbarea orei). */
function zonedToUtc(y, mo, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  let ms = guess - offsetAt(guess)
  ms = guess - offsetAt(ms)
  return ms
}

function todayParts(now) {
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day }
}

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

// §4 gasire date
const DATE_PATTERNS = [
  { re: /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g, get: (m) => [+m[3], +m[2], +m[1]] },
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, get: (m) => [+m[1], +m[2], +m[3]] },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})\\.?(?:,?\\s+(\\d{4}))?\\b`, 'g'), get: (m) => [m[3] ? +m[3] : null, MONTHS[m[2]], +m[1]] },
  { re: new RegExp(`\\b(${MONTH_EN_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'g'), get: (m) => [m[3] ? +m[3] : null, MONTHS[m[1]], +m[2]] },
]

/** Toate datele din textul normalizat: { y, m, d, start, end } (pozitii in text). */
function findDates(t, now) {
  const today = todayParts(now)
  const out = []
  for (const p of DATE_PATTERNS) {
    p.re.lastIndex = 0
    let m
    while ((m = p.re.exec(t))) {
      let [y, mo, d] = p.get(m)
      if (y === null) {
        // Fara an: cel mai apropiat viitor (anul curent sau urmatorul).
        y = today.y
        if (mo < today.m || (mo === today.m && d < today.d - 1)) y++
      }
      if (!validDate(y, mo, d)) continue
      const start = m.index
      const end = m.index + m[0].length
      if (out.some((o) => start < o.end && end > o.start)) continue
      out.push({ y, m: mo, d, start, end })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

// §5 gasire ora si locatie
const TIME_PATTERNS = [
  { kind: 'range', re: /\b(\d{1,2})[:.](\d{2})\s*(?:-|–|—|pana la|to|until)\s*(\d{1,2})[:.](\d{2})\b/ },
  { kind: '12h', re: /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/ },
  { kind: 'ora', re: /\b(?:ora|orele)\s+(\d{1,2})(?:[:.](\d{2}))?\b(?![./]\d)/ },
  { kind: 'hm', re: /\b(\d{1,2}):(\d{2})\b/ },
  { kind: 'hm', re: /\b(\d{1,2})\.(\d{2})\b(?!\.\d)/ },
]

function parseTime(win) {
  for (const p of TIME_PATTERNS) {
    const m = p.re.exec(win)
    if (!m) continue
    let h = +m[1]
    const mi = m[2] ? +m[2] : 0
    if (p.kind === '12h') {
      const pm = m[3][0] === 'p'
      if (h < 1 || h > 12) continue
      h = (h % 12) + (pm ? 12 : 0)
    }
    if (h > 23 || mi > 59) continue
    const out = { h, mi, index: m.index }
    if (p.kind === 'range' && +m[3] <= 23 && +m[4] <= 59) out.end = { h: +m[3], mi: +m[4] }
    return out
  }
  return null
}

/** Ora: intai dupa data (aceeasi fraza), apoi inainte de ea. */
function findTime(t, date) {
  const after = t.slice(date.end, date.end + 90)
  const stop = after.search(/\n\s*\n/)
  const hit = parseTime(stop >= 0 ? after.slice(0, stop) : after)
  if (hit) return hit
  return parseTime(t.slice(Math.max(0, date.start - 60), date.start))
}

const LOCATION_RE = /(?:locatia|locatie|locul|adresa|location|address|where)\s*:\s*([^\n]{3,120})|\bla sediul\s+([^\n.;]{3,100})/
const PAST_CTX_RE = /\b(ieri|yesterday|comunicat[a]?|trimis[a]?|depus[a]?|inregistrat[a]?|emis[a]?|facturat[a]?|sent|wrote|applications?\s+close|closing\s+date|termen\s+limita|valabil[a]?\s+pana|expir[ae]|expires?)\b/
const QUOTE_RE = /\n(?:\s*>.*|(?:on|in)\s+[^\n]{8,100}(?:\n[^\n]{0,60})?\b(?:wrote|a scris):\s*|(?:from|de la):\s+.+\n(?:sent|trimis|date):\s+|---+\s*(?:original message|mesaj redirectionat|forwarded message)\s*---+)/i

function stripQuoted(text) {
  const m = QUOTE_RE.exec(normSameLen(text))
  return m && m.index > 20 ? text.slice(0, m.index) : text
}

function findLocation(t, original) {
  const m = LOCATION_RE.exec(t)
  if (!m) return ''
  const idx = m.index + m[0].length - (m[1] || m[2]).length
  return original.slice(idx, idx + (m[1] || m[2]).length).trim().replace(/[,;]+$/, '')
}

// §6 filtru bulk & API public detect()
const BULK_MAILER_RE = /mailchimp|klaviyo|sendinblue|brevo|constant\s*contact|campaign\s*monitor|activecampaign|marketo|hubspot|mailerlite|convertkit|substack/i

function hdr(headers, name) {
  if (!headers) return ''
  const v = typeof headers.get === 'function' ? headers.get(name) : Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1]
  return Array.isArray(v) ? v.join('\n') : String(v || '')
}

function isBulk(headers) {
  if (!headers) return false
  if (hdr(headers, 'list-unsubscribe') || hdr(headers, 'list-unsubscribe-post') || hdr(headers, 'list-id')) return true
  if (/\b(?:bulk|list|junk)\b/i.test(hdr(headers, 'precedence'))) return true
  if (/^auto-replied\b/i.test(hdr(headers, 'auto-submitted').trim())) return true
  if (hdr(headers, 'x-mc-user') || hdr(headers, 'x-campaign') || hdr(headers, 'x-campaignid') || hdr(headers, 'x-mailgun-tag') || hdr(headers, 'x-hubspot-mid')) return true
  return BULK_MAILER_RE.test(hdr(headers, 'x-mailer'))
}

/**
 * Programari din mesaj: [{ title, start, end, allDay, location, snippet }], max 3.
 * Doar daca nu este newsletter/bulk si subiectul/textul contin un cuvant-cheie.
 */
function detect(msg, now = new Date()) {
  if (isBulk(msg && msg.headers)) return []
  const subject = String((msg && msg.subject) || '')
  let text = String((msg && msg.text) || '')
  if (!text.trim() && msg && msg.html) text = htmlToText(msg.html)
  text = stripQuoted(text).slice(0, MAX_TEXT)
  const t = normSameLen(text)
  if (!KEYWORD_RE.test(t) && !hasKeyword(subject)) return []
  const minAllDayMs = now.getTime() - 24 * 3600 * 1000
  const minTimedMs = now.getTime() - 6 * 3600 * 1000
  const location = findLocation(t, text)
  const out = []
  for (const date of findDates(t, now)) {
    const before = t.slice(Math.max(0, date.start - 60), date.start)
    if (PAST_CTX_RE.test(before)) continue
    const time = findTime(t, date)
    const allDay = !time
    const startMs = zonedToUtc(date.y, date.m, date.d, allDay ? 0 : time.h, allDay ? 0 : time.mi)
    if (startMs < (allDay ? minAllDayMs : minTimedMs)) continue
    let endMs = allDay ? startMs + 24 * 3600 * 1000 : startMs + 3600 * 1000
    if (time && time.end) {
      const e = zonedToUtc(date.y, date.m, date.d, time.end.h, time.end.mi)
      if (e > startMs) endMs = e
    }
    if (out.some((o) => o.startMs === startMs)) continue
    const a = Math.max(0, date.start - 80)
    out.push({
      startMs,
      title: subject.trim() || 'Programare',
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      allDay,
      location,
      snippet: text.slice(a, date.end + 80).replace(/\s+/g, ' ').trim().slice(0, 200),
    })
    if (out.length >= 3) break
  }
  return out.map(({ startMs, ...rest }) => rest)
}

module.exports = { detect, isBulk, norm, normSameLen, htmlToText, hasKeyword, zonedToUtc }
