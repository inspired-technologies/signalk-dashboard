# Change Log

## [Unreleased]

### Fix
- Screen brightness follows sunrise and sunset of the local day (time zone of the SignalK host): the times of day are placed on today's date, so sources publishing different days (OpenWeather: local day of the position, Open-Meteo: UTC day) or updating sunrise and sunset at different times no longer switch to daytime brightness at night.
- Without sunrise / sunset (no source yet, polar day or night) the brightness is kept - it was reset to the daytime value; the last known times are used as fallback also for renamed influx paths.
- Shared influx / cache: InfluxDB points carry the time of measurement, replayed cache points keep their tags and field type, cache files are removed only after a confirmed write, written atomically, limited to 100 MB / 30 days.
- Flushing the cache on stop when InfluxDB was never configured.

### Feature
- Shared skunits update: missing values stay missing instead of 0, Beaufort conversions, additional units.
- Automated tests (`npm test`) and SignalK Plugin CI.

### Update
- Package updates (`js-yaml` 5.5, `@signalk/signalk-schema` 1.8.6).
- SignalK Plugin CI runs in `plugin/` (`repository.directory`), the change log moved from the README to `CHANGELOG.md`.

## [0.6.2]
- Package updates.

## [0.6.1]
- Influx and skunits modules harmonized with the other Inspired Technologies plugins; publish workflow fixed.

## [0.5.1]
- Package update.

## [0.5.0]
- Influx and cache modules harmonized with the other Inspired Technologies plugins.

## [0.4.6]
- Undefined reference on an influx login error.

## [0.4.5]
- Missing path in the path configuration.

## [0.4.4]
- Sunrise and sunset are uploaded to InfluxDB.

## [0.4.3]
- Night time brightness after midnight; package update.

## [0.4.1]
- Call sign description; missing or doubled values.

## [0.4.0]
- Screen brightness changing aligned to sunrise and sunset.

## [0.3.0]
- Beta test.

## [0.2.0]
- Alpha test: Grafana kiosk (chromium tabs or grafana-kiosk), dashboard switching by navigation state, telegraf monitoring, sample dashboards.
