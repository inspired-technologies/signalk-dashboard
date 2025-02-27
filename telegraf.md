# Setting up Telegraf with InfluxDB
Telegraf collects metrics and events from RaspberryPi and adds. Telegraf is entirely plugin-driven and has a multitude of plugins already installed. 

## Install 
To have the Telegraf repository key installed, we will need to go ahead and add its
repository to the sources list. 

Add the Telegraf key and install the service to RasperryPi OS by running the following commands:
``` 
curl -fsSL https://repos.influxdata.com/influxdata-archive_compat.key | \
    gpg --dearmor | \
    sudo tee  /etc/apt/trusted.gpg.d/influxdata-archive_compat.gpg > /dev/null
source /etc/os-release
echo "deb https://repos.influxdata.com/debian ${VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/influxdb.list
sudo apt update && sudo apt install telegraf -y
```
With Telegraf now installed, set it up as a service. Run the following two commands to enable Telegraf to start at boot:
```
sudo systemctl unmask telegraf
sudo systemctl enable telegraf
```

## Configuration
For telegraf to push data interval, hostname and token of your InfluxDB most be configured in telegraf.conf.

Either use the default file or use a reduced data set like this only:
```
# Configuration for telegraf agent
[agent]
  interval = "30s"
  round_interval = true
  metric_batch_size = 1000
  metric_buffer_limit = 10000
  collection_jitter = "0s"
  flush_interval = "10s"
  flush_jitter = "0s"
  precision = ""
  debug = false
  quiet = false
  logfile = ""
  ## Override default hostname, if empty use os.Hostname()
  hostname = ""
  ## If set to true, do no set the "host" tag in the telegraf agent.
  omit_hostname = false
[[outputs.influxdb_v2]]	
  urls = ["http://localhost:8086"]
  ## Token for authentication.
  token = "<REPLACE-WITH-TOKEN>"
  ## Organization is the name of the organization you wish to write to; must exist.
  organization = "<REAPLCE-WITH-ORG>"
  ## Destination bucket to write into.
  bucket = "<REPLACE-WITH-BUCKET>"
  ## Additional HTTP settings
  timeout = "5s"
  user_agent = "telegraf"
[[inputs.cpu]]
  ## Whether to report per-cpu stats or not
  percpu = true
  ## Whether to report total system cpu stats or not
  totalcpu = true
  ## If true, collect raw CPU time metrics.
  collect_cpu_time = false
  ## If true, compute and report the sum of all non-idle CPU states.
  report_active = false
  ## If true and the info is available then add core_id and physical_id tags
  core_tags = false
[[inputs.disk]]
  ## By default stats will be gathered for all mount points.
  ## Set mount_points will restrict the stats to only the specified mount points.
  # mount_points = ["/"]
  ## Ignore mount points by filesystem type.
  ignore_fs = ["tmpfs", "devtmpfs", "devfs", "iso9660", "overlay", "aufs", "squashfs"]
[[inputs.diskio]]
[[inputs.mem]]
[[inputs.net]]
[[inputs.processes]]
[[inputs.swap]]
[[inputs.system]]
[[inputs.exec]]
  commands = ["/usr/bin/vcgencmd measure_temp"]
  name_override = "temperature_gpu"
  data_format = "grok"
  grok_patterns = ["%{NUMBER:value:float}"]
[[inputs.temp]]
```

## Service startup
Finally, start the service through system control manager:
```
sudo systemctl start telegraf
```
