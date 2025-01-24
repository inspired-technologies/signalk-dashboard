# signalk-dashboard
Server plugin &amp; Grafana dashboard for SignalK 


## additional plugins required

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

## Plugin Configration

Configure additional data points (eg. batteries, tanks, etc.) via pathconfig.json in the plugin data directory.
Position - if not covered elsewhere:
```
{ "path": "navigation.position", "policy": "instant", "config":"navigation.position|>navigation.vessel.position", "convert": "{lon,lat}|>latLng", "minPeriod": 10000 }
```
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
