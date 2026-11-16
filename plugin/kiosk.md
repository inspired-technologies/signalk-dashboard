# Grafana Kiosk

[grafana-kiosk](https://github.com/grafana/grafana-kiosk) runs a Grafana dashboard full screen in a chromium window, logs in to Grafana and is the alternative to chromium tabs in the plugin (*Launch command* `grafana-kiosk`). The plugin restarts the service with every board switch, after writing the board URL into its yaml configuration.

The binary is not shipped with the plugin - install the latest release for the kiosk host.

## Install

1. Check the architecture of the kiosk host:
   ```
   uname -m
   ```
   | `uname -m` | Release asset |
   | --- | --- |
   | `aarch64` (Raspberry Pi OS 64 bit) | `grafana-kiosk.linux.arm64` |
   | `armv7l` (Raspberry Pi OS 32 bit) | `grafana-kiosk.linux.armv7` |
   | `armv6l` (Raspberry Pi Zero / 1) | `grafana-kiosk.linux.armv6` |
   | `x86_64` | `grafana-kiosk.linux.amd64` |

2. Download the latest release and install it to `/usr/bin` (replace the asset name if needed):
   ```
   ASSET=grafana-kiosk.linux.arm64
   curl -fL -o /tmp/grafana-kiosk "https://github.com/grafana/grafana-kiosk/releases/latest/download/$ASSET"
   sudo install -m 755 /tmp/grafana-kiosk /usr/bin/grafana-kiosk
   rm /tmp/grafana-kiosk
   ```
   The installed release is listed on the [releases page](https://github.com/grafana/grafana-kiosk/releases) - v1.0.13 at the time of writing.

3. Check the binary starts:
   ```
   grafana-kiosk -h
   ```

Updating works the same way: download the latest release, `sudo install` it over the old binary and restart the service (`sudo systemctl restart grafana-kiosk`).

## Configuration

Create the yaml configuration loading your default dashboard (see [README](./README.md#grafana-kiosk-cli-test)) - the plugin replaces `target.URL` with the board of the navigation state, so the file has to be writable by the user running SignalK (locally or via the remote login).

Create the service description:
```
sudo touch /etc/systemd/system/grafana-kiosk.service
sudo chmod 664 /etc/systemd/system/grafana-kiosk.service
```
and configure grafana-kiosk to use the yaml file:
```
[Unit]
Description=Grafana Kiosk
Documentation=https://github.com/grafana/grafana-kiosk
Documentation=https://grafana.com/blog/2019/05/02/grafana-tutorial-how-to-create-kiosks-to-display-dashboards-on-a-tv/
After=network.target

[Service]
User=pi
Environment="DISPLAY=:0"
Environment="XAUTHORITY=/home/pi/.Xauthority"

# Disable screensaver and monitor standby (X11 only)
ExecStartPre=xset s off
ExecStartPre=xset -dpms
ExecStartPre=xset s noblank
ExecStart=/usr/bin/grafana-kiosk -c /home/pi/.../dashboard.yaml

[Install]
WantedBy=graphical.target
```
*Note: the `xset` lines apply to X11 desktops only - remove them on Wayland (labwc / Wayfire) and disable screen blanking in the desktop settings (`raspi-config` → Display Options → Screen Blanking) instead.*

Reload the daemon and enable the service:
```
sudo systemctl daemon-reload
sudo systemctl enable grafana-kiosk
```
Start, get status and logs:
```
sudo systemctl start grafana-kiosk
sudo systemctl status grafana-kiosk
journalctl -u grafana-kiosk
```

The plugin runs `sudo systemctl restart grafana-kiosk` (and `sudo tee` for the screen brightness) - the user running SignalK needs these as password-less sudo commands on the kiosk host.
