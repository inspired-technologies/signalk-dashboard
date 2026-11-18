# Change Log

## [Unreleased]

### Fix
- Screen brightness follows sunrise and sunset of the local day (time zone of the SignalK host): the times of day are placed on today's date, so sources publishing different days (OpenWeather: local day of the position, Open-Meteo: UTC day) or updating sunrise and sunset at different times no longer switch to daytime brightness at night.
- Without sunrise / sunset (no source yet, polar day or night) the brightness is kept - it was reset to the daytime value; the last known times are used as fallback also for renamed influx paths.
- Shared influx / cache: InfluxDB points carry the time of measurement, replayed cache points keep their tags and field type, cache files are removed only after a confirmed write, written atomically, limited to 100 MB / 30 days.
- Flushing the cache on stop when InfluxDB was never configured.
- Board switching and screen brightness no longer depend on InfluxDB - they ran in the upload timer, which only started after a passing health check.
- A navigation state without a configured board shows the default board - on the first tab it threw in the timer.
- Brightness control without a launch configuration (local kiosk) failed on an undefined command.
- Stopping the plugin during the InfluxDB health check or the start delay no longer starts the subscription afterwards.
- Sunrise / sunset are uploaded when they change, otherwise hourly - since the shared influx update only once per start (before: on every upload tick).
- Empty object values are no longer uploaded.
- Dashboard metadata (buckets, hosts, vessel, measurement labels) went missing on boards with a time range shorter than the bucket retention: the descriptions were only republished close to the retention (24 h by default), only when deltas came in, and since the shared influx update with their original timestamp. Now fresh description points are published on start and hourly (at least four times per retention), independent of incoming data; the plugin state shows when they were last published and which vessel data is missing.
- Sample dashboards: metadata is looked up over a fixed window (hidden constant `metawindow`, 7 days) instead of the selected time range - measurement queries keep the selected range; no hard-coded data source UIDs or bucket names (`${datasource}`, `${signalk}`).
- Remote kiosk status check: `$2` of the `awk` filter was expanded by the local shell around `ssh`, so the status of a running grafana-kiosk was never `active` and the service was not restarted on plugin start.
- Board switch with grafana-kiosk: the service restarts after the yaml is written - before, the restart could run while the remote write was still in progress.
- *Launch command* `chromium` for Raspberry Pi OS Trixie (Debian 13), next to `chromium-browser` (Bookworm); with boards per navigation state the plugin configuration is no longer rewritten to `chromium-tabbed`. The README lists the packages needed on the kiosk host (`wtype`, `procps`, fontconfig and DejaVu fonts).
- Launch configuration checked on start: a grafana-kiosk yaml as *Configuration params* of chromium, or no yaml with grafana-kiosk, is reported as plugin error instead of opening the yaml as a browser tab or writing board URLs into another file.

### Refactor
- One remote mechanism: commands, the grafana-kiosk yaml (sftp) and the screen brightness use a single ssh2 connection to the kiosk host instead of `ssh` client processes plus a separate ssh2 login. The connection is closed on plugin stop and re-established on the next use.
- Explicit remote login: *Remote host* (`user@host`), *SSH port* and *SSH key file* (formerly `keyFile` in the JSON configuration, still used) - no default keys, users or ssh agent; a remote host without user or key file, an unreadable key or a key with passphrase is reported as error and no screen command runs. The former *Remote command* `ssh [-p port] [-i key file] user@host` keeps working, other ssh options are rejected.

### Feature
- Sunrise / sunset preferably from the derived-data plugin (computed from position and time).
- The backlight is read back every 10 minutes and restored when something else changed it (eg. display wake-up).
- Pending offline cache files are shown on the plugin state; from half of the size or age limit, or once data had to be dropped, the state turns into an error.
- Logging via the `signalk-dashboard` debug log.
- Shared skunits update: missing values stay missing instead of 0, Beaufort conversions, additional units.
- Automated tests (`npm test`) and SignalK Plugin CI.

### Update
- Package updates (`js-yaml` 5.5, `@signalk/signalk-schema` 1.8.6).
- SignalK Plugin CI runs in `plugin/` (`repository.directory`), the change log moved from the README to `CHANGELOG.md`.
- npm release via trusted publishing (OIDC) instead of an npm token; `engines`, `signalk.displayName` and a `files` list in package.json.
- The grafana-kiosk binary is no longer kept in the repository - [kiosk.md](plugin/kiosk.md) describes how to install the latest release.

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
