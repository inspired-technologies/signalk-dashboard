const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const screen = require('../screen');

const ZONE = 'Europe/Berlin';
const CONFIG = { daytime: 225, nighttime: 15 };
// local time in Berlin on 2026-11-16 (UTC+1)
const at = (time, day = '2026-11-16') => DateTime.fromISO(`${day}T${time}`, { zone: ZONE });

// sunrise 07:20 / sunset 16:30 Berlin time = 06:20Z / 15:30Z
const RISE = '2026-11-16T06:20:00.000Z';
const SET = '2026-11-16T15:30:00.000Z';

describe('screen brightness by time of day', () => {
  it('is daytime between sunrise and sunset, night before and after', () => {
    assert.equal(screen.brightness(at('12:00'), RISE, SET, CONFIG, ZONE), 225);
    assert.equal(screen.brightness(at('07:20'), RISE, SET, CONFIG, ZONE), 225);
    assert.equal(screen.brightness(at('07:19'), RISE, SET, CONFIG, ZONE), 15);
    assert.equal(screen.brightness(at('16:30'), RISE, SET, CONFIG, ZONE), 15);
    assert.equal(screen.brightness(at('23:30'), RISE, SET, CONFIG, ZONE), 15);
    assert.equal(screen.brightness(at('00:30'), RISE, SET, CONFIG, ZONE), 15);
  });

  it('stays night with sunrise and sunset of different days (beta: reset to daytime at night)', () => {
    // this morning's sunrise from one source, tomorrow's sunset from another
    const tomorrowSet = '2026-11-17T15:29:00.000Z';
    assert.equal(screen.brightness(at('23:30'), RISE, tomorrowSet, CONFIG, ZONE), 15);
    // both already for tomorrow (published after sunset) or still for yesterday
    assert.equal(screen.brightness(at('22:00'), '2026-11-17T06:21:00.000Z', tomorrowSet, CONFIG, ZONE), 15);
    assert.equal(screen.brightness(at('02:00', '2026-11-17'), RISE, SET, CONFIG, ZONE), 15);
    assert.equal(screen.brightness(at('10:00', '2026-11-17'), RISE, SET, CONFIG, ZONE), 225);
  });

  it('takes the times of day in the local time zone, not the UTC day', () => {
    // 00:30 Berlin is still the previous UTC day - Open-Meteo publishes that UTC day
    assert.equal(screen.brightness(at('00:30', '2026-11-17'), '2026-11-16T06:20:00Z', '2026-11-16T15:30:00Z', CONFIG, ZONE), 15);
    // offsets in the published values do not matter
    assert.equal(screen.brightness(at('12:00'), '2026-11-16T07:20:00+01:00', '2026-11-16T17:30:00+02:00', CONFIG, ZONE), 225);
  });

  it('handles daylight across local midnight', () => {
    // sunset after midnight local time
    assert.equal(screen.isDaylight(at('00:15'), '2026-11-16T08:00:00+01:00', '2026-11-17T00:30:00+01:00', ZONE), true);
    assert.equal(screen.isDaylight(at('03:00'), '2026-11-16T08:00:00+01:00', '2026-11-17T00:30:00+01:00', ZONE), false);
  });

  it('keeps the current brightness without sunrise or sunset', () => {
    assert.equal(screen.brightness(at('23:30'), undefined, SET, CONFIG, ZONE), undefined);
    assert.equal(screen.brightness(at('12:00'), RISE, null, CONFIG, ZONE), undefined);
    assert.equal(screen.brightness(at('12:00'), 'waiting ...', SET, CONFIG, ZONE), undefined);
  });

  it('accepts milliseconds, Date and DateTime for now', () => {
    const noon = at('12:00');
    assert.equal(screen.isDaylight(noon.toMillis(), RISE, SET, ZONE), true);
    assert.equal(screen.isDaylight(noon.toJSDate(), RISE, SET, ZONE), true);
    assert.equal(screen.isDaylight(noon.toUTC(), RISE, SET, ZONE), true);
  });
});
