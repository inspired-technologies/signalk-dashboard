# Grafana Kiosk
Setup grafana-kiosk as service as per [instructions on github](https://github.com/grafana/grafana-kiosk)

## Install
Download the grafana-kiosk binary for your system first and then configure as service: 
```
sudo touch /etc/systemd/system/grafana-kiosk.service
sudo chmod 664 /etc/systemd/system/grafana-kiosk.service
```

## Configuration
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
