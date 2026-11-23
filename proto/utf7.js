/* MAP
 * §1 decode   L8-L21
 * §2 encode   L23-L46
 * §3 exports  L48-L49
 */
'use strict';

// §1 decode
// Modified UTF-7 (RFC 3501 §5.1.3): '&...-' = UTF-16BE in base64 cu ',' in loc de '/'.
function decode(name) {
  if (typeof name !== 'string' || name.indexOf('&') < 0) return name;
  return name.replace(/&([^-]*)-/g, (whole, chunk) => {
    if (chunk === '') return '&';
    const bytes = Buffer.from(chunk.replace(/,/g, '/'), 'base64');
    // octet impar = secventa rupta; il ignoram ca sa nu cada decodarea intregului nume
    const even = bytes.length - (bytes.length % 2);
    const le = Buffer.alloc(even);
    for (let i = 0; i < even; i += 2) { le[i] = bytes[i + 1]; le[i + 1] = bytes[i]; }
    return le.toString('utf16le');
  });
}

// §2 encode
function encodeRun(run) {
  const le = Buffer.from(run, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
  return '&' + be.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
}

function encode(name) {
  if (typeof name !== 'string') return name;
  let out = '';
  let run = '';
  for (const ch of name) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      if (run) { out += encodeRun(run); run = ''; }
      out += ch === '&' ? '&-' : ch;
    } else {
      run += ch;
    }
  }
  if (run) out += encodeRun(run);
  return out;
}

// §3 exports
module.exports = { encode, decode };
