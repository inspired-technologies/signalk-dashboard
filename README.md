# SignalK Dashboard

## Plugin & Configuration

see __[here](./plugin/README.md)__ for install and config

## Sample Dashboards

A few __[sample dashboards](./grafana/)__ optimized for a widescreen 480x1920 display are available. These show typical data points from engines, batteries, tanks as well as environmentals like weather info and forecast. Installation can be done using the Grafana Web UI through importing the JSON files mentioned below.  

| Name | Description | Vessel State | Link |
| ---- | ----------- | ------------ | ---- |
| signalk-board-idle | Generic Dashboard just showing name, position and log info | any | __[json](./grafana/signalk-board-idle.json)__ |
| signalk-board-landing | Dashboard showing generic vessel and sensor info | any | __[json](./grafana/signalk-board-landing.json)__ |
| signalk-board-moored | Dashboard tailored to information when moored | moored | __[json](./grafana/signalk-board-moored.json)__ |
| signalk-board-anchored | Dashboard tailored to information when on anchor | anchored | __[json](./grafana/signalk-board-anchored.json)__ |
| signalk-board-motoring | Dashboard when underway using engines | motoring | __[json](./grafana/signalk-board-motoring.json)__ |
| signalk-board-sailing | Dashboard when underway sailing | sailing | __[json](./grafana/signalk-board-sailing.json)__ |

Notes:

- The `signalk-board-*` dashboards are exported from Grafana 13 in the v2 dashboard format (`apiVersion: dashboard.grafana.app/v2`). Grafana releases that only know the classic dashboard JSON (eg. 11.x) cannot import them. __[rpi-monitoring](./grafana/rpi-monitoring.json)__ is still in the classic format.
- The dashboard name (eg. `signalk-board-moored`) becomes its uid, which is the `id` of a board in the plugin configuration (`/d/<id>`).
- After the import, select your InfluxDB data source once per dashboard. Buckets, hosts, vessel name and MMSI are not stored in the dashboards: they are looked up from the metadata the plugin writes to InfluxDB.
- The dashboards are samples: panels, sensors and layout will need to be adjusted to your own boat and screen.