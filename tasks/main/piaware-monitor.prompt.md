Check email for new PiAware offline alerts and reboot the Flightstats SwitchBot when one arrives. Compare alerts by Outlook MESSAGE ID — never by date/timestamp — to avoid timezone bugs.

Tracker file: /workspace/extra/Nano/finance-nano/last-piaware-alert.txt
Log file:     /workspace/extra/Nano/finance-nano/piaware-monitor.log

Steps:
1. Read the tracker file. It should contain the Outlook message ID of the last processed Offline alert on a single line (e.g. "AAjvFQjPAAA="). If the file does not exist, is empty, or contains a value that does NOT look like an Outlook message ID (e.g. an ISO timestamp like "2026-05-22T09:10:00.000Z"), treat the tracker as UNINITIALISED.
2. Run: node /workspace/tools/outlook-read.js search "from:alerts@flightaware.com subject:Offline"
3. From the results, pick the most recent Offline alert whose subject contains "PiAware Receiver" and "Offline". Record its message ID.
4. If no Offline alert is found, do nothing and stop.
5. If the tracker is UNINITIALISED: write that message ID to the tracker file (overwriting, single line, no trailing whitespace). Do NOT reboot. Append "[<current ISO UTC timestamp>] Tracker initialised to <message ID>" to the log file. Stop.
6. Otherwise, compare the alert's message ID to the tracker value.
   - If they match, do nothing and stop.
   - If they differ:
     a) FIRST, write the new message ID to the tracker file (overwrite, single line, no trailing whitespace). If this write fails for any reason (e.g. ENOSPC — disk full), STOP IMMEDIATELY without rebooting and emit a USER-VISIBLE message (outside <internal> tags) like: "PiAware monitor: cannot update tracker file (disk full?). Skipping reboot to avoid an infinite loop."
     b) Call mcp__switchbot__switchbot_control with {"device":"Flightstats","command":"turnOff"}.
     c) Wait 10 seconds (Bash: sleep 10).
     d) Call mcp__switchbot__switchbot_control with {"device":"Flightstats","command":"turnOn"}.
     e) Append "[<current ISO UTC timestamp>] Rebooted Flightstats for offline alert <message ID>" to the log file.

Hard rule: never use email dates or timestamps to decide whether to reboot — compare message IDs only. Wrap ALL output in <internal>...</internal> tags so no WhatsApp message is sent unless step 6a triggers the disk-full error path.
