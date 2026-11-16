/*
    Copyright © 2026 Inspired Technologies GmbH (www.inspiredtechnologies.eu)

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    Screen brightness by time of day.
    Sources publish environment.sunlight.times.sunrise / sunset for different days - OpenWeather
    for the local day of the position, Open-Meteo for the UTC day, and every source updates them at
    its own time. Comparing the raw timestamps mixes days (eg. this morning's sunrise with tomorrow's
    sunset reads as daytime at night). The times of day are therefore taken in the local time zone
    and placed on the local date of <now>: daylight from sunrise to sunset of that date.
*/

const { DateTime } = require('luxon')

function toDateTime(value, zone) {
    if (DateTime.isDateTime(value))
        return value.setZone(zone)
    if (value instanceof Date)
        return DateTime.fromJSDate(value).setZone(zone)
    if (typeof value === 'number')
        return DateTime.fromMillis(value).setZone(zone)
    if (typeof value === 'string')
        return DateTime.fromISO(value, { setZone: true }).setZone(zone)
    return null
}

// time of day of <time> on the local date of <today>
function onDate(time, today) {
    return time.set({ year: today.year, month: today.month, day: today.day })
}

// true: daylight, false: night, undefined: sunrise or sunset unknown (eg. polar day / night, no source yet)
function isDaylight(now, sunrise, sunset, zone = 'local') {
    const today = toDateTime(now, zone)
    const rise = toDateTime(sunrise, zone)
    const set = toDateTime(sunset, zone)
    if (!today || !rise || !set || !today.isValid || !rise.isValid || !set.isValid)
        return undefined
    const from = onDate(rise, today)
    const to = onDate(set, today)
    // sunset after local midnight (time zone far off the solar time): daylight wraps around midnight
    return from <= to ? today >= from && today < to : today >= from || today < to
}

// brightness for <now> - undefined keeps the current brightness
function brightness(now, sunrise, sunset, config, zone = 'local') {
    const daylight = isDaylight(now, sunrise, sunset, zone)
    if (daylight === undefined)
        return undefined
    return daylight ? config.daytime : config.nighttime
}

module.exports = {
    isDaylight,
    brightness
}
