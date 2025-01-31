# signalk-dashboard
Server plugin &amp; dashboards for SignalK 

## Purpose
Consider this plugin if you have at least one RaspberryPi connected to a screen installed in your boat environment and connected some NMEA data sources. It will allow for displaying current and historical measurements stored in a timeseries database as well as monitoring your boat IT infrastructure. If you already configured dashboarding using grafana you can simply leverage the plugin to automatically start you preferred dashboard during SignalK server launch  - and in addition  switch boards according to the change of navigation states.

## Install & Use

### Prerequisites
- RaspberryPi 3/4/5 64bit Bullseye or Bookworm OS with minimal desktop enabled or chromium browser installed  
*Note: Alternative browsers, likewise Firefox may be possible to be configure, but have not been tested*
- SignalK Server (v2.x) installed and configured
- InfluxDB (v1.8.x or v2.7.x) - for details see next section
*Note: For InfluxDB v3 (aka Influx Edge) has been recently made available as alpha-version for development and will be made available at at a later stage*
- Grafana (v11.5.x)
- Telegraf (v1.33.x or similar, if compatibel with the InfluxDB version used)
*Note: not required, but beneficial in case infra monitoring should be done*

Combining all services into a single device may work, but is not necessarily recommended for production to avoid performance issues when heavier data load is expected. A distributed implementation having SignalK separated from InfluxDB and Grafana may be better and is supported by the plugin; yet, requires some additional configuration steps - see also ...

### SignalK Plugin configuration
Install the plugin from the SignalK app store and configure as outlined below: 
- Grafana configuration is required to specify the default dashboard as well as additional alternative dashboards per navigation state
- Influx configuration shall be required to provide setup and device information to the various dashboards
- Telegraf configuration is optional and may be done very lite according to your monitoring needs, eg. CPU load and temperature at a minimum
Post installation 'Activate' the plugin on the SignalK plugin config page.

###  Browser Kiosk or Grafana Kiosk
The plugin in principle supports 2 different modes of operation when displaying dashboards in a kiosk-alike experience:
- Chromium browser in full-screen with the grafana dashboard loaded in kiosk mode. In order to enable switching dashboards according to navigation states tabbed browsing is leveraged.
- Alternatively the same can be achieved by the __[grafana-kiosk utility](https://github.com/grafana/grafana-kiosk)__ configured as a system service.
While both modes should accomplish the same result, tabbed browsing may bare a certain risk of getting out of sync with the signalling of states from the server; in order to reduce the risk, some delays may be experienced during switching. On the other hand the Grafana Kiosk service needs to be restarted with each navigation state change and hence, will also cause some screen 'flickering' ...

### Grafana configuration 
In prinicple no specific configuration needs to be done to the grafana service other than configuring an appropriate data source connecting to the InfluxDB in use and updating the dashboards accordingly.
*Note: For test purposes you might want to import rpi-monitoring.json into your grafana dashboard list*

### InfluxDB configuration
In order for this plugin to work InfluxDB needs to be accessible and configured. Using the latest __[JS client](https://influxdata.github.io/influxdb-client-js/influxdb-client.html)__ v2 API, the plugin supports both OSS version 1.8.x (32bit) and 2.7.x (64bit). 
*
Notes: 
- Implementation likely is in the same local network as the SignalK server, but could be be hosted on docker or alternatively in the cloud
- Flux as query language is defaulted on v2.x, but has recently be moved into maintenance mode. Sample dashboards provided with this plugin still use Flux to enquiry. 
- For Influx v1.8.x Flux can be __[enabled, but is disabled by default](https://docs.influxdata.com/influxdb/v1/flux/installation/)__ 
*

Enter your influx connection as

| Configuration | Influx v1.8.x | Influx OSS v2.x |
| ------------- | ------------- | --------------- |
| URI           | http(s)://url:port | http(s)://url:port |
| Token         | username:password | token       |
| Organisation  | empty         | required        |
| Bucket        | database/retentionpolicy | bucket          |

### Chromium browser cli test
In order to verify that installation and configuration was successful run the following command in bash using a ssh shell login to your RPi:
```
chromium-browser "https://time.is/Berlin" "http://localhost:port/d/rpi-monitor/rpi-monitoring?kiosk&orgId=1&timezone=Europe%2FBerlin&refresh=5m" --kiosk --noerrdialogs --disable-infobars --no-first-run --ozone-platform=wayland --enable-features=OverlayScrollbar --start-maximized & 
```
*Note: Tests have been with Raspberry OS configured to wayland backend with labwc instead of X11 or Wayfire, but any other configuration might work fine as well.*
This should load the RPi Monitor Dashboard in full screen and Grafana in Kiosk mode like this:
[image]
Use the following command to switch between tabs:
```
wtype -M ctrl -P Tab
```
which brings the next tab showing time in Berlin, Germany.
[image]
In order stop the browser, identify the process id via
```
pgrep chromium | head -1
```
and kill the executed process with
```
kill <id returned from previous cmd>
```

### Grafana Kiosk cli test
Create or modify the grafana kiosk yaml confiugration to load your default dashboard:
```
general:
  kiosk-mode: full
  autofit: true
  lxde: false
  lxde-home: /home/pi
  scale-factor: 1
target:
  login-method: local
  username: pi
  password: **redacted**
  playlist: false
  URL: >-
    http://localhost:port/d/rpi-monitor/rpi-monitoring?kiosk&orgId=1&timezone=Europe%2FBerlin&refresh=5m
  ignore-certificate-errors: false
``` 
In order to verify that installation and configuration was successful run the kiosk from the cmd line:
```
/usr/bin/grafana-kiosk -c /home/pi/signalk-dashboard.yaml
```
Finally, configure grafana-kiosk as system service

## Dashboards

### Plugin configuration

### Additional grafana plugins

### Sample Dashboards

### Descriptions handling

### Data handling


## Additional grafana plugins
Some non-standard grafana plugins may be of interest to visualize data points likewise wind on a windrose or graph.

### Spectraphilic Windrose
- Clone https://github.com/spectraphilic/grafana-windrose
- Enable unsigned grafana plugin
```
sudo mkdir -p /var/lib/grafana/plugins/spectraphilic-windrose-panel
sudo cp -r [git-dir]/dist/* /var/lib/grafana/plugins/spectraphilic-windrose-panel
sudo chown -R grafana /var/lib/grafana/plugins/spectraphilic-windrose-panel
sudo chgrp -R grafana /var/lib/grafana/plugins/spectraphilic-windrose-panel
sudo chmod -R 750 /var/lib/grafana/plugins/spectraphilic-windrose-panel
sudo ls -al /var/lib/grafana/plugins
```
- Edit /etc/grafana/grafana.ini:
```
...
app_mode = development
...
[plugins]
allow_loading_unsigned_plugins = spectraphilic-windrose-panel
...
```
- Reboot / restart grafana-server

### VolkovLab eCharts
install via 
```
grafana-cli plugins install volkovlabs-echarts-panel
```

## Path configration


Position - if not covered elsewhere:
```
{ "path": "navigation.position", "policy": "instant", "config":"navigation.position|>navigation.vessel.position", "convert": "{lon,lat}|>latLng", "minPeriod": 10000 }
```

Configure additional data points (eg. batteries, tanks, etc.) via pathconfig.json in the plugin data directory.

Batteries & Tanks:
```
  { "path": "electrical.batteries.*.voltage", "period": 10000, "policy": "instant", "config": "label.~:electrical.batteries|>batteries", "minPeriod": 10000 },
  { "path": "tanks.freshWater.*.currentLevel", "period": 10000, "policy": "instant", "config": "type.fresh.label.~:freshWater.currentLevel|>level", "minPeriod": 10000 },
  { "path": "tanks.fuel.*.currentLevel", "period": 10000, "policy": "instant", "config": "type.fuel.label.~:fuel.currentLevel|>level", "minPeriod": 10000 }
```

## Grafana Kiosk
Setup grafana-kiosk as service as per [instructions on github](https://github.com/grafana/grafana-kiosk): 
```
sudo touch /etc/systemd/system/grafana-kiosk.service
sudo chmod 664 /etc/systemd/system/grafana-kiosk.service
```
Configure grafana kiosk to use a specific configuration yaml file within the service description: 
```
[Unit]
Description=Grafana Kiosk
Documentation=https://github.com/grafana/grafana-kiosk
Documentation=https://grafana.com/blog/2019/05/02/grafana-tutorial-how-to-create-kiosks-to-display-dashboards-on-a->After=network.target

[Service]
User=pi
Environment="DISPLAY=:0"
Environment="XAUTHORITY=/home/pi/.Xauthority"

# Disable screensaver and monitor standby
ExecStartPre=xset s off
ExecStartPre=xset -dpms
ExecStartPre=xset s noblank
ExecStart=/usr/bin/grafana-kiosk -c /home/pi/src/signalk-config/dashboard.yaml

[Install]
WantedBy=graphical.target
```
Restart the daemon service and enable the service
```
sudo systemctl daemon-reload
sudo systemctl enable grafana-kiosk
```
Start, Get Status, and logs:
```
sudo systemctl start grafana-kiosk
sudo systemctl status grafana-kiosk
journalctl -u grafana-kiosk
```

## Notes
https://grafana.com/blog/2019/05/02/grafana-tutorial-how-to-create-kiosks-to-display-dashboards-on-a-tv/
https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/
https://github.com/grafana/grafana-kiosk
