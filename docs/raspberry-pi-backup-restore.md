# Raspberry Pi backup and restore runbook

This runbook records the `fluxpi` Bookworm-to-Trixie migration and provides a
checklist for a similar production system running InfluxDB OSS v2, Grafana,
Telegraf and a Grafana kiosk. It assumes a new SD card, a local Grafana SQLite
database and a Raspberry Pi OS desktop. Adapt paths, users, versions, buckets
and services to the target; do not apply the examples blindly.

The commands are Bash commands for the Pi, not for the development workstation.
Run each section in order, review errors before proceeding, and do not paste
tokens, passwords, private keys or configuration contents into chat.

## Plan and inventory

- [ ] Schedule downtime and identify every InfluxDB writer, scheduled task and
  external integration, including Telegraf on **other** hosts. A hostname change
  alone does not isolate a host if its old IP address is reused.
- [ ] Record the hostname, IP address, time zone, storage capacity and usage,
  user accounts, network configuration, mounted filesystems and display setup.
  Confirm the new card has enough space for restored data and growth.
- [ ] Record installed InfluxDB server and CLI, Grafana, Telegraf, kiosk and
  Chromium versions; enabled services; package sources; systemd overrides;
  startup dependencies; and any non-default paths.
- [ ] Identify Grafana's actual database type and location, configuration,
  provisioning, plugin paths and effective `secret_key`, including any
  environment files or external secret provider. A database export alone does
  not preserve the key needed to decrypt saved data-source credentials.
- [ ] Securely retain the InfluxDB **operator token** and the tokens required
  by writers and data sources. InfluxDB 2.9 and later hash tokens by default:
  the backup does not reveal their plaintext, and an existing token cannot be
  recovered from the server. Save the original operator token separately before
  backup or upgrade.
- [ ] Preserve the old SD card as a rollback option. Identify and mount a
  separate backup device; keep an additional verified encrypted copy off the Pi.
  Store the encryption passphrase separately from the backups.

## Back up the source

### 1. Pause writers and tasks

Stop or pause SignalK writers, remote and local Telegraf instances, other
clients, and any InfluxDB tasks that write data or call external systems. Check
their actual state, not just the service configuration. Record the pause time.
Keep them paused until cutover.

Take the **final** backup only after the pause. Anything written after that
snapshot is not included; resuming the old system and then booting the new
card does not merge those writes. If writers resume before cutover, pause them
again and repeat the final backup.

### 2. Back up InfluxDB

On the source Pi, create a private working directory and use an operator token.
Keep `WORK` for the following commands in the same shell.

```bash
umask 077
WORK=$(mktemp -d "$HOME/pi-migration.XXXXXXXX")
echo "Private staging directory: $WORK"

read -r -s -p 'InfluxDB operator token: ' INFLUX_TOKEN
printf '\n'
export INFLUX_TOKEN
influx backup --host http://127.0.0.1:8086 "$WORK/influx"
unset INFLUX_TOKEN
```

Confirm the backup completed successfully. Do not equate its compressed size
with the on-disk database size or treat it as verified until a restore succeeds.

### 3. Back up Grafana and configuration

For a package installation using the default SQLite paths, stop Grafana while
archiving its configuration, provisioning, database and plugins. If the
database is MySQL or PostgreSQL, use the appropriate database-native backup
instead. Include additional paths, external secrets and service overrides
discovered in the inventory.

```bash
(
  set -eu
  : "${WORK:?Set WORK to the private staging directory}"
  systemctl is-active --quiet grafana-server || {
    echo 'Grafana is not active; inspect its state before backing up.' >&2
    exit 1
  }
  sudo systemctl stop grafana-server
  trap 'sudo systemctl start grafana-server || echo "ERROR: Grafana restart failed" >&2' EXIT

  paths=(etc/grafana var/lib/grafana)
  [ ! -f /etc/default/grafana-server ] || paths+=(etc/default/grafana-server)
  sudo tar --acls --xattrs -cpf "$WORK/grafana.tar" -C / "${paths[@]}"
  sudo chown "$(id -u):$(id -g)" "$WORK/grafana.tar"
  chmod 600 "$WORK/grafana.tar"
)
systemctl is-active grafana-server
```

Capture configuration separately: SSH `authorized_keys` and any required client
keys, network settings, hostname, DNS, NTP, time zone, mounts, boot/display
settings, sudoers, udev rules, systemd units and overrides, Telegraf, kiosk
YAML, desktop/autostart configuration, CLI profiles and package versions.
Treat the archive as secret. Inspect service symlinks and archive their
**targets** as well as `systemctl cat` output; a tar archive of a symlink alone
does not contain its target.

Example for a `pi` user and the paths used on `fluxpi`; add or remove paths
after inspecting the target. This does not cover custom locations automatically.

```bash
(
  set -eu
  : "${WORK:?Set WORK to the private staging directory}"
  paths=()
  for p in \
    etc/ssh root/.ssh home/pi/.ssh home/pi/.influxdbv2 \
    home/pi/config/board home/pi/.config/labwc home/pi/.config/autostart \
    etc/systemd/system etc/sudoers etc/sudoers.d etc/telegraf \
    etc/influxdb etc/influxdb2 etc/default etc/apt \
    etc/NetworkManager/system-connections etc/network etc/wpa_supplicant \
    etc/dhcpcd.conf etc/hostname etc/hosts etc/timezone etc/fstab \
    etc/crontab etc/cron.d var/spool/cron etc/udev/rules.d \
    boot/firmware/config.txt boot/firmware/cmdline.txt
  do
    if sudo test -e "/$p"; then paths+=("$p"); fi
  done
  sudo tar --acls --xattrs --numeric-owner -cpf "$WORK/system-config.tar" -C / "${paths[@]}"
  sudo chown "$(id -u):$(id -g)" "$WORK/system-config.tar"
  chmod 600 "$WORK/system-config.tar"
  dpkg-query -W -f='${binary:Package} ${Version}\n' > "$WORK/package-versions.txt"
  systemctl list-unit-files --state=enabled --no-pager > "$WORK/enabled-services.txt"
  if systemctl cat grafana-kiosk > "$WORK/grafana-kiosk-unit.txt"; then
    echo 'Kiosk unit saved; inspect its referenced files locally.'
  else
    echo 'Kiosk unit unavailable; record the actual kiosk startup mechanism.' >&2
  fi
)
```

Review the archive listing and referenced symlink targets locally. Do not
include secrets in a public inventory or repository. Keep the Influx CLI
configuration, usually `~/.influxdbv2/configs`, private: it contains tokens.

### 4. Encrypt and verify

Choose a **new** destination filename on a mounted, independent backup
device. The example uses `/mnt/backup`; verify the mount is the intended
device. The staging directory remains plaintext and private until cleanup.

```bash
(
  set -e
  set -o pipefail
  : "${WORK:?Set WORK to the private staging directory}"
  DEST=/mnt/backup
  mountpoint -q "$DEST" || { echo 'Backup device is not mounted.' >&2; exit 1; }
  if [ -e "$DEST/pi-migration.tar.gpg" ] || [ -e "$DEST/pi-migration.SHA256SUMS" ]; then
    echo 'Destination archive or checksum already exists; choose new names.' >&2
    exit 1
  fi
  tar -C "$(dirname "$WORK")" -cf - "$(basename "$WORK")" |
    gpg --pinentry-mode loopback --symmetric --cipher-algo AES256 \
      --output "$DEST/pi-migration.tar.gpg"
  gpg --pinentry-mode loopback --decrypt "$DEST/pi-migration.tar.gpg" |
    tar -tf - >/dev/null
  (cd "$DEST" && sha256sum pi-migration.tar.gpg > pi-migration.SHA256SUMS &&
    sha256sum -c pi-migration.SHA256SUMS)
)
```

Copy the encrypted archive and checksum to another device and verify that
copy. A checksum detects accidental corruption, not malicious replacement;
successful decryption/listing is not a restore test. Record the snapshot time,
backup location and verification result without recording secrets.

## Prepare the new card

1. Shut down the old Pi and label its card; keep it unchanged.
2. Flash Raspberry Pi OS Trixie 64-bit **with desktop** to the new card. Verify
   the destination device before flashing. Configure SSH, the intended user,
   time zone and networking.
3. Use an isolated test network where possible; prevent clients from reaching
   the new server until the restore is validated. Boot and verify display,
   touch, resolution, orientation and power before applying any old overlays.
   Do not copy the old boot configuration wholesale.
4. Install the same known-working InfluxDB server/CLI and Grafana versions
   initially, using the vendors' signed package repositories. Check package
   availability and compatibility rather than assuming old versions remain
   available. Record version changes and upgrade separately.
5. Verify the encrypted backup and extract it into a new private directory
   (`umask 077`). List the archive before extraction. It contains credentials.
   Check its recorded ownership, file modes and symlink targets before applying
   individual files.

For the archive created above, this lists and extracts it into a private
directory. Verify the checksum on the copied device first, and extract only
backups from a trusted source.

```bash
(
  set -e
  set -o pipefail
  umask 077
  STAGE=$(mktemp -d "$HOME/pi-restore.XXXXXXXX")
  gpg --pinentry-mode loopback --decrypt /mnt/backup/pi-migration.tar.gpg | tar -tf -
  gpg --pinentry-mode loopback --decrypt /mnt/backup/pi-migration.tar.gpg | tar -xf - -C "$STAGE"
  echo "Private restore directory: $STAGE"
  find "$STAGE" -maxdepth 2 \( -name influx -o -name grafana.tar -o -name system-config.tar \) -print
)
```

Set `RESTORED_BACKUP` to the extracted `pi-migration.*` directory shown by
`find`, and `INFLUX_DIR` to its `influx` subdirectory. Do not copy the
placeholder literally.

## Restore InfluxDB

**A full restore replaces all InfluxDB data and metadata on the target.** Use
only a new, empty target, and keep writers and scheduled tasks paused. This
procedure was used with InfluxDB 2.9.1 and CLI 2.8.0. For a hashed-token backup,
CLI 2.8.0 or later and the original operator token are required.

1. Add a temporary, uniquely named systemd drop-in to bind InfluxDB to
   `127.0.0.1:8086` and set `INFLUXD_NO_TASKS=true`. Do not overwrite an existing
   override. On a new target using the `influxdb` systemd service:

   ```bash
   (
     set -e
     override=/etc/systemd/system/influxdb.service.d/migration-isolation.conf
     sudo install -d -m 755 /etc/systemd/system/influxdb.service.d
     if sudo test -e "$override"; then
       echo 'Isolation override already exists; inspect it first.' >&2
       exit 1
     fi
     printf '[Service]\nEnvironment=INFLUXD_HTTP_BIND_ADDRESS=127.0.0.1:8086\nEnvironment=INFLUXD_NO_TASKS=true\n' |
       sudo tee "$override" >/dev/null
     sudo systemctl daemon-reload
     sudo systemctl start influxdb
     ss -ltn '( sport = :8086 )'
     curl --noproxy '*' -fsS http://127.0.0.1:8086/health
     echo
   )
   ```

   Confirm it listens only on localhost and health reports success.
2. Initialize the empty instance with temporary user, organization and bucket
   values. Use the **source operator token** for setup and the restore; the
   full restore replaces the temporary metadata. Use a private, temporary
   `INFLUX_CONFIGS_PATH` so setup does not overwrite an existing CLI profile.
3. Run the full restore with the extracted **Influx backup directory**, not the
   outer archive. For example, with `INFLUX_TOKEN` securely read into the
   environment and `INFLUX_DIR` set to that directory:

   ```bash
   influx setup --host http://127.0.0.1:8086
   influx restore --host http://127.0.0.1:8086 --full --operator-token="$INFLUX_TOKEN" "$INFLUX_DIR"
   ```

   `INFLUX_TOKEN` is mapped to the setup and restore CLI token options. The
   `--operator-token` argument may be visible to other local users in the
   process list: perform this step only on a trusted host. Do not put a literal
   token in shell history. Clear the variable after use. If setup or restore
   fails, stop and inspect the target and the
   [recovery instructions](https://docs.influxdata.com/influxdb/v2/admin/backup-restore/restore/);
   do not blindly repeat setup or restore.
4. Verify original users, organizations, bucket IDs and retention policies,
   the original operator token, and **historical points** in each expected
   bucket. An empty time range is not by itself proof of a failed restore.
   Inspect task status and schedules before re-enabling them.
5. Restore the original Influx CLI profile only if appropriate, without
   overwriting an existing profile. It is separate from the server restore and
   contains plaintext credentials.

## Restore Grafana and system configuration

1. With Grafana stopped and only on the new target, restore the verified
   Grafana archive's intended paths, ownership and permissions. Review the
   archive first; restoring over an existing system can overwrite its data.
   Verify that restored ownership maps to the new `grafana` account; service
   UIDs and GIDs can differ between installations. Reapply the same effective
   `secret_key`, environment files and provisioning.

   For the default-path archive above, after reviewing its contents and setting
   `RESTORED_BACKUP`:

   ```bash
   (
     set -eu
     : "${RESTORED_BACKUP:?Set RESTORED_BACKUP to the extracted backup directory}"
     sudo systemctl stop grafana-server
     sudo tar --acls --xattrs -xpf "$RESTORED_BACKUP/grafana.tar" -C /
     sudo systemctl start grafana-server
   )
   ```

   If extraction or startup fails, investigate before continuing; Grafana may
   remain stopped.
2. Start Grafana and verify its health endpoint, login, restored dashboards,
   data-source connection and historical data. Check custom plugins and
   unsigned-plugin settings. Registration alone does not prove a panel renders.
3. Restore SSH access selectively. Prefer retaining the new host keys; verify
   the new host-key fingerprint out of band before updating clients'
   `known_hosts`. Restore `authorized_keys` and required client keys with
   restrictive permissions. Test from each actual client.
4. Review network settings, DNS, firewall, service overrides, kiosk YAML,
   Telegraf and sudo rules before applying them. Do not restore an entire
   `/etc` or boot configuration over the new OS. Validate sudoers with
   `visudo -c`; grant only the needed privileges unless broader access is
   explicitly approved.
5. Install and verify the kiosk executable for the correct architecture and
   restore its configuration and service. On Wayland, X11 `xset` commands do
   not control compositor blanking and can fail before the display is ready.
   Check startup ordering, retry behavior and the actual desktop environment.
6. Restore Telegraf's configuration with restricted permissions and test inputs
   as the Telegraf user. `telegraf --test` does **not** test outputs and may
   report input errors despite a successful exit; inspect its logs. For
   `vcgencmd`, check the actual `/dev/vcio_gencmd` ownership and the service
   user's group membership; restart the service after any group change.

## Cutover and verification

1. Verify the restored InfluxDB and Grafana while writers remain paused. Remove
   only the temporary localhost binding, retain the task-disable override, and
   restart InfluxDB when ready for remote clients. Confirm its listener,
   firewall and health. Do not expose it before the intended cutover.
2. After reviewing task schedules and side effects, remove only the temporary
   task-disable override and restart InfluxDB. Verify a new scheduled run
   succeeds; an enabled task or an old successful run is not sufficient.
3. Start Telegraf and deliberately resume SignalK and other writers. Check
   logs, then query recent points in the **actual output bucket and
   organization**, including per-host Telegraf metrics. Inspect remote Telegraf
   instances too. A successful health check does not validate their tokens.
4. If a client gets `401`, verify its destination, token and authorization
   without sharing secrets. A restored backup may not contain tokens created
   after the snapshot. Create a dedicated least-privilege token if needed and
   verify actual writes. Telegraf can drop metrics when its buffer overflows;
   dropped metrics are not recovered by restarting it. HTTP sends tokens
   unencrypted on the network; assess TLS and network isolation.
5. Confirm live dashboard data and each required custom panel. Test kiosk
   access from the SignalK host, board switching during a real navigation-state
   change, automatic brightness, touch and idle blanking. Do not simulate
   vessel state on a production network merely to test switching.
6. Enable the required services at boot. At an agreed time, reboot and verify
   SSH, display, kiosk, Grafana, InfluxDB, Telegraf, post-boot writer data and
   the next task run. A running service is not proof of working data flow.
7. Retain the old SD card and encrypted backups. After validation and a verified
   independent backup, remove only the identified plaintext staging files and
   unnecessary credentials, with approval. Keep any explicitly designated
   plugin rollback copy until the update is accepted.

## Observations from `fluxpi`

- The final Bookworm snapshot was taken with writers paused. InfluxDB 2.9.1,
  CLI 2.8.0, Grafana 13.2.3 and Telegraf 1.40.1 were restored on Trixie.
  Grafana's SQLite database, configuration, plugins and data-source credentials
  were restored; historical data and current writes were verified.
- The encrypted archives and checksum were saved under
  `/mnt/sd/fluxpi-backup-2Pus8H1z/`: `fluxpi-initial.tar.gpg`,
  `fluxpi-config.tar.gpg` and `SHA256SUMS`. The private extracted restore
  staging directory was `/home/pi/fluxpi-restore.O7i47Unc`; it contains
  sensitive material and is not a substitute for the encrypted backups.
- The new SSH host keys were retained and authorized keys restored. The
  original unrestricted `pi` passwordless sudo rule was restored only after
  explicit approval; it is not a recommended default for other environments.
- The Waveshare 8.8-inch DSI display and touch worked after the hardware issue
  was addressed. The desktop used labwc/Wayland. Removing the old `xset`
  pre-start commands and adding kiosk retry allowed startup after reboot.
  Idle display and automatic brightness were verified; plugin-driven board
  switching remained to be checked during a natural state change.
- A remote `skdevpi` Telegraf instance had an invalid restored authorization
  and dropped buffered metrics. A new bucket-scoped token fixed writes; access
  to `/dev/vcio_gencmd` required the `video` group. A separate local Telegraf
  instance needed the same device permission.
- The restored `spectraphilic-windrose-panel` 0.0.2 was already registered
  despite unsigned-plugin warnings, but its panel reported fewer than two
  series. The local upstream checkout's 0.1.0 `dist` was deployed, keeping
  0.0.2 at `/var/lib/grafana/windrose-before-0.1.0`, outside the plugin
  directory, for rollback. The panel worked after a reboot. The plugin remains
  unsigned; assess its trust and compatibility for each environment before
  enabling it.

## References

- [InfluxDB backup](https://docs.influxdata.com/influxdb/v2/admin/backup-restore/backup/)
- [InfluxDB restore and failure recovery](https://docs.influxdata.com/influxdb/v2/admin/backup-restore/restore/)
- [Grafana backup](https://grafana.com/docs/grafana/latest/administration/back-up-grafana/)
- [Grafana Windrose plugin](https://github.com/spectraphilic/grafana-windrose)
- [Kiosk setup](../plugin/kiosk.md) and [Telegraf setup](../plugin/telegraf.md)
