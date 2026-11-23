/* MAP
 * §1 setup   L8-L14
 * §2 zones   L15-L62
 * §3 fields  L63-L108
 */
'use strict';

// §1 setup
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIcs, parseDuration } = require('../proto/ics');

const cal = (...ev) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', ...ev, 'END:VCALENDAR'].join('\r\n');

// §2 zones
test('TZID Europe/Bucharest: vara (+3) si iarna (+2), DST corect', () => {
  const r = parseIcs(cal(
    'BEGIN:VEVENT', 'UID:vara', 'DTSTART;TZID=Europe/Bucharest:20260715T100000', 'DTEND;TZID=Europe/Bucharest:20260715T113000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:iarna', 'DTSTART;TZID=Europe/Bucharest:20261215T100000', 'DURATION:PT45M', 'END:VEVENT',
    // 29 martie 2026, 03:00 ora locala nu exista (salt 03:00 → 04:00)
    'BEGIN:VEVENT', 'UID:salt', 'DTSTART;TZID="Europe/Bucharest":20260329T043000', 'END:VEVENT',
  ));
  assert.equal(r.method, 'REQUEST');
  assert.equal(r.events.length, 3);
  assert.equal(r.events[0].start, '2026-07-15T07:00:00.000Z');
  assert.equal(r.events[0].end, '2026-07-15T08:30:00.000Z');
  assert.equal(r.events[1].start, '2026-12-15T08:00:00.000Z');
  assert.equal(r.events[1].end, '2026-12-15T08:45:00.000Z');
  assert.equal(r.events[2].start, '2026-03-29T01:30:00.000Z');
  assert.equal(r.events[2].end, r.events[2].start);
  assert.equal(r.events[0].allDay, false);
});

test('zone Windows, mozilla, UTC Z, ora flotanta, alta zona IANA', () => {
  const r = parseIcs(cal(
    'BEGIN:VEVENT', 'DTSTART;TZID=GTB Standard Time:20261110T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;TZID="W. Europe Standard Time":20260801T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;TZID=/mozilla.org/20070129_1/Europe/London:20260801T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261110T090000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261110T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261110T090000', 'END:VEVENT',
  ));
  assert.deepEqual(r.events.map((e) => e.start), [
    '2026-11-10T07:00:00.000Z', '2026-08-01T07:00:00.000Z', '2026-08-01T08:00:00.000Z',
    '2026-11-10T09:00:00.000Z', '2026-11-10T07:00:00.000Z', '2026-11-10T14:00:00.000Z',
  ]);
});

test('allDay: VALUE=DATE, fara DTEND → +1 zi, DURATION pe zile', () => {
  const r = parseIcs(cal(
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261227', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261231', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260101', 'DURATION:P2D', 'END:VEVENT',
  ));
  assert.deepEqual(r.events.map((e) => [e.allDay, e.start, e.end]), [
    [true, '2026-12-24', '2026-12-27'], [true, '2026-12-31', '2027-01-01'], [true, '2026-01-01', '2026-01-03'],
  ]);
  assert.equal(parseDuration('-PT15M'), -900000);
  assert.equal(parseDuration('P1W'), 604800000);
  assert.equal(parseDuration('X'), null);
});

// §3 fields
test('Outlook: despaturire, escape-uri, ORGANIZER/ATTENDEE, STATUS, SEQUENCE, VALARM ignorat', () => {
  const text = cal(
    'BEGIN:VTIMEZONE', 'TZID:GTB Standard Time', 'BEGIN:STANDARD', 'DTSTART:16010101T040000', 'TZOFFSETTO:+0200', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'ORGANIZER;CN="Popescu, Ion":mailto:ion@firma.ro',
    'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Ana Mureșan:mailto:ana@x.ro',
    'ATTENDEE;CN="office@example.com";PARTSTAT=ACCEPTED:MAILTO:office@example.com',
    'DESCRIPTION:Agenda:\\n1. buget\\, plan\\; termene\\n2. alte\\\\ri',
    ' sc',
    '\turi',
    'SUMMARY;LANGUAGE=ro-RO:Ședință de proiect',
    'LOCATION:Sala 2\\, etaj 3',
    'DTSTART;TZID=GTB Standard Time:20261118T140000',
    'DTEND;TZID=GTB Standard Time:20261118T150000',
    'UID:040000008200E00074C5B7101A82E008',
    'STATUS:CONFIRMED',
    'SEQUENCE:2',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'BEGIN:VALARM', 'DESCRIPTION:REMINDER', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT',
  );
  const r = parseIcs(text);
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.equal(e.uid, '040000008200E00074C5B7101A82E008');
  assert.equal(e.summary, 'Ședință de proiect');
  assert.equal(e.description, 'Agenda:\n1. buget, plan; termene\n2. alte\\riscuri');
  assert.equal(e.location, 'Sala 2, etaj 3');
  assert.equal(e.start, '2026-11-18T12:00:00.000Z');
  assert.equal(e.end, '2026-11-18T13:00:00.000Z');
  assert.deepEqual(e.organizer, { name: 'Popescu, Ion', address: 'ion@firma.ro' });
  assert.equal(e.attendees.length, 2);
  assert.deepEqual(e.attendees[0], { name: 'Ana Mureșan', address: 'ana@x.ro', partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT', rsvp: true });
  assert.equal(e.attendees[1].address, 'office@example.com');
  assert.equal(e.status, 'confirmed');
  assert.equal(e.sequence, 2);
  assert.equal(e.rrule, 'FREQ=WEEKLY;COUNT=3');
});

test('METHOD:CANCEL si text gol', () => {
  const r = parseIcs('BEGIN:VCALENDAR\nMETHOD:CANCEL\nBEGIN:VEVENT\nUID:x\nSTATUS:CANCELLED\nDTSTART:20261201T080000Z\nEND:VEVENT\nEND:VCALENDAR\n');
  assert.equal(r.method, 'CANCEL');
  assert.equal(r.events[0].status, 'cancelled');
  assert.deepEqual(parseIcs(''), { method: null, events: [] });
});
