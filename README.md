# PostgreSQL & Neon Standalone Backup Tool (`v1.1.0`)

A zero-dependency, battle-tested, standalone backup, restore, retention pruning, and Telegram bot CLI for PostgreSQL and Neon databases.

---

## Features

- **Zero-Dependency `.env` Auto-Loader:** Automatically reads `.env` in the current working directory or script directory without external packages.
- **Granular Scopes:** Backup and restore full databases (`--all`), schemas (`--schema`), row data (`--data`), roles (`--roles`), routines/triggers (`--functions`), or RLS policies (`--rls`).
- **Built-in Retention & Pruning:** Automatically prunes expired backup archives by age (`--retention=14d`) or by file count (`--keep=10`), plus a standalone `prune` command.
- **Dead Man's Switch & Webhooks:** Pings Healthchecks.io / Cronitor (`/start`, `/`, `/fail`) and posts JSON alerts to Discord, Slack, or custom webhooks.
- **Telegram Alerts & File Delivery:** Sends HTML status notifications and optionally uploads backup archives under Telegram's 50 MB Bot API limit.
- **Interactive Telegram Bot Daemon (`bot-daemon.ts`):** Manage backups remotely via `/status`, `/history`, `/backup`, `/restore` (with mandatory pre-restore safety snapshot), `/prune`, and `/get`.
- **Precompiled Binary Support:** Compile into a single static Linux executable via `bun build --compile`—run on any VPS without Bun or Node installed.

---

## Repository Contents

| File            | Description                                                                                            |
| :-------------- | :----------------------------------------------------------------------------------------------------- |
| `db-backup.ts`  | Standalone backup & restore CLI/library (`v1.1.0`). Works with Bun or Node.js (`>=22` type-stripping). |
| `bot-daemon.ts` | Optional Telegram long-polling bot daemon for remote backup/restore management.                        |
| `.env.example`  | Template for environment variables.                                                                    |
| `package.json`  | Package metadata, bin entry, and helper scripts.                                                       |

---

## Quick Start on a VPS

### 1. Prerequisites

Install the PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`):

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y postgresql-client

# CentOS / RHEL / Fedora
sudo dnf install -y postgresql
```

_(Ensure the PostgreSQL client major version matches or is newer than your database server version.)_

### 2. Clone & Configure

```bash
git clone https://github.com/omariyassinee/db-backup.git /opt/db-backup
cd /opt/db-backup
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```env
# PostgreSQL / Neon Direct (Unpooled) Connection URL
DATABASE_ROOT_URL="postgresql://user:password@host:5432/dbname?sslmode=require"

# Local backup directory
BACKUP_DIR="/opt/db-backup/backup/db"

# Retention policy
BACKUP_RETENTION_DAYS=14

# Optional: Healthchecks.io ping URL
# BACKUP_PING_URL="https://hc-ping.com/your-uuid-here"

# Optional: Telegram alerts & bot daemon
# BACKUP_TELEGRAM_TOKEN="123456789:AA..."
# BACKUP_TELEGRAM_CHAT_ID="123456789"
# BACKUP_TELEGRAM_SEND_FILES=true
```

> **Important (Neon):** Always use the **direct** connection string from your Neon console (Connection Pooling = OFF). Do not use hostnames ending with `-pooler`.

---

## Scheduling

### Option A: `systemd` Timer & Bot Service (Recommended on VPS)

`/etc/systemd/system/db-backup.service`:

```ini
[Unit]
Description=Database Backup Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/opt/db-backup
ExecStart=/usr/local/bin/bun db-backup.ts backup --all
StandardOutput=journal
StandardError=journal
```

`/etc/systemd/system/db-backup.timer`:

```ini
[Unit]
Description=Daily Database Backup Timer

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

Optional bot daemon (`/etc/systemd/system/db-backup-bot.service`):

```ini
[Unit]
Description=Database Backup Telegram Bot Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/db-backup
ExecStart=/usr/local/bin/bun bot-daemon.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable them:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now db-backup.timer
sudo systemctl enable --now db-backup-bot.service
```

### Option B: Cron

```cron
0 2 * * * cd /opt/db-backup && bun db-backup.ts backup --all >> /var/log/db-backup.log 2>&1
```

---

## CLI Reference

### Commands

- `backup` (or `b`): Execute database backup for selected scopes.
- `restore` (or `r`): Restore database from a backup archive.
- `list` (or `ls`): List existing backup files in the backup directory.
- `prune`: Remove old backups according to retention policy.
- `help`: Display help screen.

### Scopes

- `--all` (`-a`): Complete dump (schemas, tables, functions, RLS policies, data).
- `--schema` (`-s`): Schema DDL structures only (no table data).
- `--data` (`-d`): Table row data only.
- `--roles`: Database roles and grants (automatically filters internal service accounts).
- `--functions`: User-defined routines, stored procedures, and triggers.
- `--rls`: Row-Level Security enablement and policies.
- `--options=schema,rls`: Run multiple specific scopes.

### Retention & Pruning Flags

- `--retention=14d`: Delete archives older than 14 days.
- `--retention=7c`: Keep only the 7 newest archives per scope.
- `--retention-days=N`: Explicit day limit.
- `--keep=N`: Explicit count limit.

### Monitoring & Telegram Flags

- `--ping-url=https://hc-ping.com/UUID`: Sends start, success, and fail pings to Healthchecks.io.
- `--webhook=https://...`: Sends a JSON payload to Slack / Discord / Webhook.
- `--telegram-token=<tok>`: Telegram Bot API token (or `BACKUP_TELEGRAM_TOKEN`).
- `--telegram-chat-id=<id>`: Telegram chat/channel ID (or `BACKUP_TELEGRAM_CHAT_ID`).
- `--telegram-thread-id=<id>`: Telegram supergroup topic ID (or `BACKUP_TELEGRAM_THREAD_ID`).
- `--telegram-send-files`: Upload archives `<50 MB` to chat (or `BACKUP_TELEGRAM_SEND_FILES=true`).

---

## Safe Restoration

Restore from the latest backup interactively:

```bash
bun db-backup.ts restore --latest
```

An interactive confirmation challenge will appear:

```
CHALLENGE: Type "restore" to confirm destructive restore:
```

For automated / non-interactive restore (e.g. staging sync scripts), pass `--force` or `--challenge=restore`:

```bash
bun db-backup.ts restore --latest --force
```

---

## Telegram Bot Commands (`bot-daemon.ts`)

When `bot-daemon.ts` is running, the authorized `BACKUP_TELEGRAM_CHAT_ID` user can send:

- `/status` — Target DB, archive count, backup disk usage, VPS disk, next timer run, retention policy
- `/history` — Interactive list of recent backups with one-tap **Download** and **Restore** buttons
- `/backup` — Trigger an immediate `--all` backup
- `/restore [filename]` — Two-step confirmation restore (captures a mandatory safety snapshot first; aborts if snapshot fails)
- `/prune` — Run retention cleanup immediately
- `/get <filename>` — Download a specific archive (up to 50 MB)

---

## Compiling a Standalone Binary

```bash
bun run build
# or: bun build --compile --minify db-backup.ts --outfile db-backup
```
