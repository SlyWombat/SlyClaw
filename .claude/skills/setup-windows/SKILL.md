# SlyClaw on Windows (WSL2 + Docker)

This skill gets Windows ready to run SlyClaw, then hands off to `/setup` for the rest. It covers everything WSL2-specific that the standard setup doesn't handle.

**Principle:** Do the work. Only pause when genuinely required (e.g. user must run a Windows command, or a WSL2 restart is needed). Be explicit about which steps happen in Windows vs WSL2.

---

## 1. Confirm WSL2 Environment

Detect whether you're already running inside WSL2:

```bash
uname -r
```

If the kernel version contains `microsoft` or `WSL`, you're inside WSL2. Continue.

If not, tell the user: "This skill must be run from inside a WSL2 terminal (e.g. Ubuntu from the Start menu), not from Windows PowerShell or Command Prompt. Open your WSL2 distro and run `claude` again."

---

## 2. Check WSL2 Distro Version

Verify the distro is WSL version 2 (not WSL 1):

```bash
cat /proc/version
```

If output contains `microsoft-standard-WSL2`, good. If it contains `Microsoft` without `WSL2`, the distro may be running on WSL1.

**If WSL1:** Tell the user to open PowerShell as Administrator and run:
```powershell
wsl --set-version Ubuntu 2
```
Wait for confirmation before continuing.

---

## 3. Enable Systemd in WSL2

Systemd is required for the SlyClaw background service. Check if it's enabled:

```bash
cat /etc/wsl.conf 2>/dev/null || echo "no wsl.conf"
```

Look for `systemd=true` under a `[boot]` section.

**If systemd is NOT enabled:**

Add the configuration:
```bash
sudo tee -a /etc/wsl.conf > /dev/null <<'EOF'

[boot]
systemd=true
EOF
```

Then tell the user:

> "WSL2 needs to restart to enable systemd. Please do the following:
> 1. Close this terminal
> 2. Open PowerShell and run: `wsl --shutdown`
> 3. Reopen your WSL2 terminal (Ubuntu from the Start menu)
> 4. Run `claude` again and re-run `/setup-windows`
>
> This only needs to be done once."

**Stop here** until user confirms they've restarted and systemd is active. After restart, verify:
```bash
systemctl --user status 2>&1 | head -5
```
If this returns without "Failed to connect to bus", systemd is running.

---

## 4. Check and Install Node.js

```bash
node --version 2>/dev/null || echo "not_found"
```

**If Node 20+ found:** Continue.

**If missing or too old:** Install via nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

Then source nvm (it won't be active in the current shell until sourced):
```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

Install Node 22:
```bash
nvm install 22
nvm use 22
nvm alias default 22
```

Verify: `node --version`

Ensure nvm is initialised on every shell start — check `~/.bashrc` for the nvm block. If missing, add it:
```bash
cat >> ~/.bashrc <<'EOF'

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
EOF
```

---

## 5. Install Claude Code

```bash
claude --version 2>/dev/null || echo "not_found"
```

**If missing:**
```bash
npm install -g @anthropic-ai/claude-code
```

Verify: `claude --version`

---

## 6. Check Docker

```bash
docker info 2>&1 | head -5
```

**If Docker is running:** Continue.

**If `Cannot connect to the Docker daemon` or `command not found`:**

AskUserQuestion: How is Docker installed?

- **Docker Desktop for Windows** (most common) — Docker Desktop must be running (look for the whale icon in the system tray). If not running, ask the user to start it. Also confirm WSL integration is enabled:
  > "In Docker Desktop: Settings → Resources → WSL Integration → Enable integration with your Ubuntu distro. Apply & Restart."
  Wait for user to confirm, then re-run `docker info`.

- **Docker Engine directly in WSL2** (no Docker Desktop) — Install it:
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
  ```
  Then tell the user: "You've been added to the docker group. Please close and reopen your terminal, then run `claude` again to continue." Stop here.

- **Docker not installed at all** — Recommend Docker Desktop for Windows. Tell the user:
  > "Download and install Docker Desktop from https://www.docker.com/products/docker-desktop
  > During install: enable the WSL2 backend.
  > After install: in Docker Desktop settings, go to Resources → WSL Integration and enable your Ubuntu distro.
  > Let me know when it's done."
  Wait for confirmation, then re-check with `docker info`.

---

## 7. Install Git (if needed)

```bash
git --version 2>/dev/null || echo "not_found"
```

**If missing:**
```bash
sudo apt-get update && sudo apt-get install -y git
```

---

## 8. Clone SlyClaw

AskUserQuestion: Where do you want to install SlyClaw? (default: `~/SlyClaw`)

Clone the repo:
```bash
git clone https://github.com/SlyWombat/SlyClaw.git ~/SlyClaw
cd ~/SlyClaw
```

(If the user has already cloned or forked it, use their existing directory.)

---

## 9. WSL2-Specific Notes Before /setup

Before handing off, confirm two things that affect the standard setup flow on WSL2:

**Puppeteer (Chrome/Chromium) flags** — WSL2 requires `--no-sandbox` for Chrome to run inside containers. SlyClaw's code already includes these flags by default. No action needed.

**QR code display** — The auth step opens a QR code page in your Windows browser using `explorer.exe`. This works automatically on WSL2. If it doesn't open, you can manually open the file at `store/qr-auth.html`.

---

## 10. Run Standard Setup

```bash
cd ~/SlyClaw
claude
```

Then run `/setup`. The standard setup skill handles everything from here: dependencies, Docker image build, Claude authentication, WhatsApp authentication, service registration, and starting the systemd service.

---

## 11. Enable Service Auto-Start (Linger)

After `/setup` completes and the service is running, enable linger so the service keeps running even when you close the WSL2 terminal:

```bash
loginctl enable-linger $USER
```

Verify:
```bash
loginctl show-user $USER | grep Linger
```
Should output `Linger=yes`.

Without this, the systemd user service stops when you close your last WSL2 terminal session.

---

## 12. Optional: Start SlyClaw Automatically When Windows Boots

By default, WSL2 only starts when you open a terminal. To have SlyClaw run automatically at Windows startup:

AskUserQuestion: Do you want SlyClaw to start automatically when Windows boots?

**If yes:**

Create a Windows startup script. Tell the user to:

1. Press `Win + R`, type `shell:startup`, press Enter
2. In that folder, create a new file named `slyclaw.vbs` with this content:

```vbs
Set ws = CreateObject("WScript.Shell")
ws.Run "wsl -d Ubuntu -u YOUR_USERNAME -- /bin/bash -c 'systemctl --user start slyclaw.service'", 0, False
```

Replace `YOUR_USERNAME` with their WSL2 username and `Ubuntu` with their distro name if different.

3. Save the file. SlyClaw will now start on the next Windows boot.

To get their WSL2 username: `echo $USER`
To get their distro name: `wsl -l` (run from PowerShell) or check Windows Terminal profiles.

**If no:** Skip.

---

## Troubleshooting

**`systemctl` says "Failed to connect to bus: No such file or directory":**
Systemd is not running. Re-do step 3 — ensure `/etc/wsl.conf` has `systemd=true` and restart WSL2 with `wsl --shutdown`.

**Docker Desktop is running but `docker info` fails in WSL2:**
WSL integration not enabled. In Docker Desktop: Settings → Resources → WSL Integration → enable your distro → Apply & Restart.

**`npm install -g @anthropic-ai/claude-code` fails with EACCES:**
Using system Node instead of nvm. Install nvm (step 4) and reinstall Node through it — nvm installs to `~/.nvm` so global packages don't need sudo.

**QR code page doesn't open automatically:**
Open File Explorer and navigate to `\\wsl$\Ubuntu\home\YOUR_USERNAME\SlyClaw\store\qr-auth.html`. Or run `explorer.exe store/qr-auth.html` from the project directory.

**Service starts but WhatsApp disconnects on WSL2 restart:**
Normal — WhatsApp re-authenticates on first run after a cold restart. If it keeps disconnecting, check `logs/slyclaw.log` for errors and re-run `/setup` from the WhatsApp auth step.

**High memory usage:**
WSL2 can use significant RAM. Create `C:\Users\YOUR_WINDOWS_USER\.wslconfig` to limit it:
```ini
[wsl2]
memory=4GB
processors=2
```
Then `wsl --shutdown` and restart.
