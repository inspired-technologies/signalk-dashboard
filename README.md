# SignalK Dashboard

## Plugin && Configuration

see __[here](./plugin/README.md)__ for install and config

## Sample Dashboards

A few __[sample dashboards](./grafana/)__ optimized for a widescreen 480x1920 display are available. These show typical data points from engines, batteries, tanks as well as environmentals like weather info and forecast. Installation can be done using the Grafana Web UI through importing the JSON files mentioned below.  

| Name | Description | Vessel State |
| ---- | ----------- | ------------ |
| signalk-board-idle | Generic Dashboard just showing name, position and log info | any |
| signalk-board-landing | Dashboard showing generic vessel and sensor info | any |
| signalk-board-moored | Dashboard tailored to information when moored | moored |
| signalk-board-anchored | Dashboard tailored to information when on anchor | anchored |
| signalk-board-motoring | Dashboard when underway using engines | motoring |
| signalk-board-sailing | Dashboard when underway sailing | sailing |