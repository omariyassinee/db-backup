#!/usr/bin/env bun
import child_process from "node:child_process";
import path from "node:path";
import url from "node:url";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Environment & Configuration Loader
// ---------------------------------------------------------------------------

function loadDotEnv(envPath?: string): void {
  const candidatePaths: string[] = [];
  if (envPath) {
    candidatePaths.push(path.resolve(process.cwd(), envPath));
  } else {
    candidatePaths.push(path.resolve(process.cwd(), ".env"));
    try {
      const scriptDir = path.dirname(url.fileURLToPath(import.meta.url));
      candidatePaths.push(path.resolve(scriptDir, ".env"));
    } catch {
      // Ignore
    }
  }

  for (const target of candidatePaths) {
    if (fs.existsSync(target)) {
      try {
        const content = fs.readFileSync(target, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx === -1) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1);
          }
          if (key && process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
        break;
      } catch {
        // Silently continue
      }
    }
  }
}

loadDotEnv();

const BOT_TOKEN = process.env.BACKUP_TELEGRAM_TOKEN?.trim();
const AUTHORIZED_CHAT_ID = process.env.BACKUP_TELEGRAM_CHAT_ID?.trim();
const BACKUP_DIR = path.resolve(
  process.cwd(),
  process.env.BACKUP_DIR || "backup/db",
);
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !AUTHORIZED_CHAT_ID) {
  console.error(
    "[bot-daemon] Missing BACKUP_TELEGRAM_TOKEN or BACKUP_TELEGRAM_CHAT_ID in environment.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Restoration State Management (Safety First)
// ---------------------------------------------------------------------------

interface PendingRestore {
  filename: string;
  expiresAt: number;
  token: string;
}

let pendingRestore: PendingRestore | null = null;
let isOperationInProgress = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
}

async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }
    await fetch(`${BASE_URL}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[bot-daemon] sendMessage failed:", (err as Error).message);
  }
}

async function sendTelegramDocument(
  chatId: string | number,
  filePath: string,
  caption?: string,
): Promise<void> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > 50 * 1024 * 1024) {
    await sendTelegramMessage(
      chatId,
      `⚠️ <b>File exceeds 50 MB limit</b>\nFilename: <code>${escapeHtml(path.basename(filePath))}</code> (${formatBytes(stat.size)})\nTelegram Bot API does not permit document uploads exceeding 50 MB.`,
    );
    return;
  }

  const bytes = new Uint8Array(await fs.promises.readFile(filePath));
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([bytes]), path.basename(filePath));
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }

  try {
    await fetch(`${BASE_URL}/sendDocument`, {
      method: "POST",
      body: form,
    });
  } catch (err) {
    console.error("[bot-daemon] sendDocument failed:", (err as Error).message);
  }
}

async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  try {
    await fetch(`${BASE_URL}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch {
    // Ignore
  }
}

function listBackupFiles(): {
  name: string;
  path: string;
  size: number;
  mtime: Date;
}[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter(
      (f) => f.endsWith(".dump") || f.endsWith(".sql") || f.endsWith(".backup"),
    )
    .map((name) => {
      const full = path.join(BACKUP_DIR, name);
      const st = fs.statSync(full);
      return { name, path: full, size: st.size, mtime: st.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

// ---------------------------------------------------------------------------
// Command Handlers
// ---------------------------------------------------------------------------

async function handleHelp(chatId: string | number): Promise<void> {
  const msg =
    `🛡️ <b>Database Backup & Recovery Bot</b>\n\n` +
    `<b>Available Commands:</b>\n` +
    `• /status — Storage, database, and schedule status\n` +
    `• /history — List recent backups (download & restore)\n` +
    `• /backup — Trigger an immediate database backup\n` +
    `• /restore — Restore database (safety snapshot first)\n` +
    `• /prune — Clean up old backups according to retention policy\n` +
    `• /help — Show this help screen\n\n` +
    `<i>Note: Every restore automatically captures a pre-restore backup of current data first.</i>`;
  await sendTelegramMessage(chatId, msg);
}

async function handleStatus(chatId: string | number): Promise<void> {
  const files = listBackupFiles();
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  let diskUsage = "Unknown";
  try {
    const dfOut = child_process
      .execSync('df -h / | awk \'NR==2 {print $3 "/" $2 " (" $5 " used)"}\'', {
        encoding: "utf-8",
      })
      .trim();
    if (dfOut) diskUsage = dfOut;
  } catch {
    // Ignore
  }

  let nextRun = "Active (daily at 02:00 UTC)";
  try {
    const timerOut = child_process
      .execSync(
        "systemctl list-timers db-backup.timer --no-pager | grep db-backup",
        {
          encoding: "utf-8",
        },
      )
      .trim();
    if (timerOut) {
      const parts = timerOut.split(/\s+/);
      if (parts.length >= 3) {
        nextRun = `${parts[0]} ${parts[1]} ${parts[2]}`;
      }
    }
  } catch {
    // Ignore
  }

  let dbInfo = "PostgreSQL";
  if (process.env.DATABASE_ROOT_URL) {
    try {
      const u = new URL(process.env.DATABASE_ROOT_URL);
      const dbName = u.pathname.replace(/^\//, "");
      dbInfo = `<code>${escapeHtml(dbName)}</code> on <code>${escapeHtml(u.hostname)}</code>`;
    } catch {
      // Ignore
    }
  }

  const msg =
    `📊 <b>System & Backup Status</b>\n\n` +
    `• <b>Target Database:</b> ${dbInfo}\n` +
    `• <b>Total Backups:</b> ${files.length} archive(s)\n` +
    `• <b>Total Disk Used by Backups:</b> ${formatBytes(totalBytes)}\n` +
    `• <b>VPS Disk:</b> ${escapeHtml(diskUsage)}\n` +
    `• <b>Next Scheduled Run:</b> ${escapeHtml(nextRun)}\n` +
    `• <b>Retention Policy:</b> ${process.env.BACKUP_RETENTION_DAYS || "14"} days`;

  await sendTelegramMessage(chatId, msg);
}

async function handleHistory(chatId: string | number): Promise<void> {
  const files = listBackupFiles();
  if (files.length === 0) {
    await sendTelegramMessage(
      chatId,
      "📂 <b>Backup History</b>\n\nNo backup archives found in repository.",
    );
    return;
  }

  const recent = files.slice(0, 8);
  let text = `📂 <b>Backup History (Recent ${recent.length})</b>\n\n`;

  const inlineKeyboard: { text: string; callback_data: string }[][] = [];

  for (let i = 0; i < recent.length; i++) {
    const f = recent[i];
    const dateStr = f.mtime.toISOString().replace("T", " ").slice(0, 19);
    text += `${i + 1}. <b>${escapeHtml(f.name)}</b>\n`;
    text += `   • Size: <code>${formatBytes(f.size)}</code> | Date: <code>${dateStr}</code>\n\n`;

    inlineKeyboard.push([
      {
        text: `⬇️ Download #${i + 1} (${formatBytes(f.size)})`,
        callback_data: `dl:${f.name}`,
      },
      {
        text: `🔄 Restore #${i + 1}`,
        callback_data: `rst_req:${f.name}`,
      },
    ]);
  }

  await sendTelegramMessage(chatId, text, { inline_keyboard: inlineKeyboard });
}

async function handleBackup(chatId: string | number): Promise<void> {
  if (isOperationInProgress) {
    await sendTelegramMessage(
      chatId,
      "⚠️ An operation is already in progress. Please wait.",
    );
    return;
  }

  isOperationInProgress = true;
  await sendTelegramMessage(
    chatId,
    "⏳ <b>Backup Initiated</b>\nRunning database backup for all scopes...",
  );

  const startTime = Date.now();
  const scriptDir = path.dirname(url.fileURLToPath(import.meta.url));
  const scriptPath = path.resolve(scriptDir, "db-backup.ts");

  child_process.execFile(
    "bun",
    [scriptPath, "backup", "--all"],
    (error, stdout, stderr) => {
      isOperationInProgress = false;
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      if (error) {
        const errDetail = stderr || stdout || error.message;
        sendTelegramMessage(
          chatId,
          `❌ <b>Backup Failed (${duration}s)</b>\n<pre>${escapeHtml(errDetail.slice(-1500))}</pre>`,
        );
      } else {
        console.log(
          `[bot-daemon] Manual backup triggered by user completed in ${duration}s.`,
        );
      }
    },
  );
}

async function handlePrune(chatId: string | number): Promise<void> {
  if (isOperationInProgress) {
    await sendTelegramMessage(
      chatId,
      "⚠️ An operation is already in progress. Please wait.",
    );
    return;
  }

  isOperationInProgress = true;
  await sendTelegramMessage(chatId, "🧹 <b>Pruning Backups...</b>");

  const scriptDir = path.dirname(url.fileURLToPath(import.meta.url));
  const scriptPath = path.resolve(scriptDir, "db-backup.ts");
  const retention = process.env.BACKUP_RETENTION_DAYS || "14";

  child_process.execFile(
    "bun",
    [scriptPath, "prune", `--retention=${retention}d`],
    (error, stdout) => {
      isOperationInProgress = false;
      if (error) {
        sendTelegramMessage(
          chatId,
          `❌ <b>Prune Error</b>\n${escapeHtml(error.message)}`,
        );
      } else {
        sendTelegramMessage(
          chatId,
          `✅ <b>Prune Complete</b>\n<pre>${escapeHtml(stdout.trim())}</pre>`,
        );
      }
    },
  );
}

async function handleDownload(
  chatId: string | number,
  filename: string,
): Promise<void> {
  const safeName = path.basename(filename);
  const targetPath = path.join(BACKUP_DIR, safeName);

  if (!fs.existsSync(targetPath)) {
    await sendTelegramMessage(
      chatId,
      `❌ <b>File not found:</b> <code>${escapeHtml(safeName)}</code>`,
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    `📤 Sending <code>${escapeHtml(safeName)}</code>...`,
  );
  await sendTelegramDocument(
    chatId,
    targetPath,
    `<b>${escapeHtml(safeName)}</b>`,
  );
}

// ---------------------------------------------------------------------------
// Two-Step Safe Restoration Handlers
// ---------------------------------------------------------------------------

async function handleRestoreRequest(
  chatId: string | number,
  filename?: string,
): Promise<void> {
  if (isOperationInProgress) {
    await sendTelegramMessage(
      chatId,
      "⚠️ An operation is already in progress. Please wait.",
    );
    return;
  }

  const files = listBackupFiles();
  if (files.length === 0) {
    await sendTelegramMessage(
      chatId,
      "❌ No backup archives found to restore.",
    );
    return;
  }

  const targetFile = filename ? path.basename(filename) : files[0].name;
  const fullPath = path.join(BACKUP_DIR, targetFile);

  if (!fs.existsSync(fullPath)) {
    await sendTelegramMessage(
      chatId,
      `❌ Backup archive not found: <code>${escapeHtml(targetFile)}</code>`,
    );
    return;
  }

  const stat = fs.statSync(fullPath);
  const token = Math.random().toString(36).slice(2, 8);

  pendingRestore = {
    filename: targetFile,
    expiresAt: Date.now() + 60000, // 60 seconds validity
    token,
  };

  let dbName = "PostgreSQL";
  if (process.env.DATABASE_ROOT_URL) {
    try {
      dbName = new URL(process.env.DATABASE_ROOT_URL).pathname.replace(
        /^\//,
        "",
      );
    } catch {
      // Ignore
    }
  }

  const warningMsg =
    `⚠️ <b>CONFIRM DATABASE RESTORATION</b>\n\n` +
    `• <b>Target Database:</b> <code>${escapeHtml(dbName)}</code>\n` +
    `• <b>Archive to Restore:</b> <code>${escapeHtml(targetFile)}</code> (${formatBytes(stat.size)})\n\n` +
    `🛡️ <b>MANDATORY PRE-RESTORE SAFETY BACKUP:</b>\n` +
    `Before restoring, a snapshot of the <b>current database</b> will be automatically created. If that backup fails, the restore is instantly aborted.\n\n` +
    `<i>This operation will overwrite current database contents. Confirm within 60s:</i>`;

  const inlineKeyboard = [
    [
      {
        text: "🔴 YES, CREATE BACKUP & RESTORE",
        callback_data: `rst_confirm:${token}`,
      },
      { text: "❌ Cancel", callback_data: "rst_cancel" },
    ],
  ];

  await sendTelegramMessage(chatId, warningMsg, {
    inline_keyboard: inlineKeyboard,
  });
}

async function handleRestoreConfirm(
  chatId: string | number,
  token: string,
): Promise<void> {
  if (!pendingRestore || pendingRestore.token !== token) {
    await sendTelegramMessage(
      chatId,
      "⚠️ Restore confirmation expired or invalid. Please request again.",
    );
    return;
  }

  if (Date.now() > pendingRestore.expiresAt) {
    pendingRestore = null;
    await sendTelegramMessage(
      chatId,
      "⏱️ Restore confirmation timed out (exceeded 60s). Operation aborted.",
    );
    return;
  }

  const targetFile = pendingRestore.filename;
  pendingRestore = null;

  if (isOperationInProgress) {
    await sendTelegramMessage(
      chatId,
      "⚠️ An operation is already in progress.",
    );
    return;
  }

  isOperationInProgress = true;
  const scriptDir = path.dirname(url.fileURLToPath(import.meta.url));
  const scriptPath = path.resolve(scriptDir, "db-backup.ts");
  const targetPath = path.join(BACKUP_DIR, targetFile);

  await sendTelegramMessage(
    chatId,
    `🛡️ <b>Step 1/2: Taking Safety Snapshot...</b>\nBacking up current database before restoration...`,
  );

  const safetyStart = Date.now();

  // STEP 1: SAFETY BACKUP OF CURRENT DATA
  child_process.execFile(
    "bun",
    [scriptPath, "backup", "--all"],
    (backupErr, backupStdout, backupStderr) => {
      if (backupErr) {
        isOperationInProgress = false;
        const errDetail = backupStderr || backupStdout || backupErr.message;
        sendTelegramMessage(
          chatId,
          `🚫 <b>RESTORE ABORTED FOR SAFETY</b>\n\n` +
            `Failed to capture pre-restore safety snapshot:\n` +
            `<pre>${escapeHtml(errDetail.slice(-1500))}</pre>\n\n` +
            `<i>No changes were made to your database.</i>`,
        );
        return;
      }

      const safetySec = ((Date.now() - safetyStart) / 1000).toFixed(1);

      // STEP 2: RESTORE REQUESTED ARCHIVE
      sendTelegramMessage(
        chatId,
        `✅ <b>Safety Snapshot Complete (${safetySec}s)</b>\n\n` +
          `🔄 <b>Step 2/2: Restoring Database...</b>\nApplying <code>${escapeHtml(targetFile)}</code>...`,
      );

      const restoreStart = Date.now();
      child_process.execFile(
        "bun",
        [scriptPath, "restore", `--file=${targetPath}`, "--challenge=restore"],
        (restoreErr, restoreStdout, restoreStderr) => {
          isOperationInProgress = false;
          const restoreSec = ((Date.now() - restoreStart) / 1000).toFixed(1);

          if (restoreErr) {
            const errDetail =
              restoreStderr || restoreStdout || restoreErr.message;
            sendTelegramMessage(
              chatId,
              `❌ <b>Restore Failed (${restoreSec}s)</b>\n` +
                `<pre>${escapeHtml(errDetail.slice(-1500))}</pre>\n\n` +
                `<i>Your pre-restore safety snapshot was saved in your backup history.</i>`,
            );
          } else {
            sendTelegramMessage(
              chatId,
              `🎉 <b>Database Restored Successfully!</b>\n\n` +
                `• <b>Restored Archive:</b> <code>${escapeHtml(targetFile)}</code>\n` +
                `• <b>Restore Time:</b> ${restoreSec}s\n` +
                `• <b>Safety Snapshot:</b> Saved in your backup history.`,
            );
          }
        },
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Long Polling Loop
// ---------------------------------------------------------------------------

async function registerBotCommands(): Promise<void> {
  try {
    const commands = [
      { command: "status", description: "System status & storage stats" },
      { command: "history", description: "List backups (download & restore)" },
      { command: "backup", description: "Trigger immediate backup" },
      {
        command: "restore",
        description: "Restore database (auto safety backup)",
      },
      { command: "prune", description: "Prune expired backups" },
      { command: "help", description: "Show available commands" },
    ];
    await fetch(`${BASE_URL}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });
  } catch (err) {
    console.warn("[bot-daemon] setMyCommands failed:", (err as Error).message);
  }
}

async function startPolling(): Promise<void> {
  console.log(
    `[bot-daemon] Starting Telegram command listener for authorized chat: ${AUTHORIZED_CHAT_ID}`,
  );
  await registerBotCommands();

  let offset = 0;

  while (true) {
    try {
      const res = await fetch(
        `${BASE_URL}/getUpdates?offset=${offset}&timeout=25`,
        {
          signal: AbortSignal.timeout(35000),
        },
      );

      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      const data = (await res.json()) as {
        ok: boolean;
        result: {
          update_id: number;
          message?: {
            from?: { id: number };
            chat?: { id: number };
            text?: string;
          };
          callback_query?: {
            id: string;
            from: { id: number };
            message?: { chat?: { id: number } };
            data?: string;
          };
        }[];
      };

      if (!data.ok || !data.result) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        // 1. Handle Callback Queries (Inline buttons)
        if (update.callback_query) {
          const cb = update.callback_query;
          const fromId = String(cb.from.id);
          const chatId = cb.message?.chat?.id || fromId;

          // Strict Authorization Check
          if (fromId !== AUTHORIZED_CHAT_ID) {
            await answerCallbackQuery(cb.id, "Unauthorized");
            continue;
          }

          if (cb.data?.startsWith("dl:")) {
            const filename = cb.data.slice(3);
            await answerCallbackQuery(cb.id, "Sending archive...");
            await handleDownload(chatId, filename);
          } else if (cb.data?.startsWith("rst_req:")) {
            const filename = cb.data.slice(8);
            await answerCallbackQuery(cb.id, "Confirm restore...");
            await handleRestoreRequest(chatId, filename);
          } else if (cb.data?.startsWith("rst_confirm:")) {
            const token = cb.data.slice(12);
            await answerCallbackQuery(
              cb.id,
              "Starting safety backup & restore...",
            );
            await handleRestoreConfirm(chatId, token);
          } else if (cb.data === "rst_cancel") {
            pendingRestore = null;
            await answerCallbackQuery(cb.id, "Restore cancelled.");
            await sendTelegramMessage(
              chatId,
              "❌ Restore operation cancelled.",
            );
          }
          continue;
        }

        // 2. Handle Text Messages
        if (update.message?.text) {
          const msg = update.message;
          const msgText = update.message.text;
          const fromId = String(msg.from?.id);
          const chatId = msg.chat?.id || fromId;

          // Strict Authorization Check
          if (fromId !== AUTHORIZED_CHAT_ID) {
            console.warn(
              `[bot-daemon] Unauthorized access attempt from user ID: ${fromId}`,
            );
            continue;
          }

          const rawText = msgText.trim();
          const cmd = rawText.split(" ")[0].toLowerCase().split("@")[0];

          switch (cmd) {
            case "/start":
            case "/help":
              await handleHelp(chatId);
              break;
            case "/status":
              await handleStatus(chatId);
              break;
            case "/history":
            case "/list":
              await handleHistory(chatId);
              break;
            case "/backup":
              await handleBackup(chatId);
              break;
            case "/restore": {
              const parts = rawText.split(/\s+/);
              await handleRestoreRequest(chatId, parts[1]);
              break;
            }
            case "/prune":
              await handlePrune(chatId);
              break;
            default:
              if (cmd.startsWith("/get")) {
                const parts = rawText.split(/\s+/);
                if (parts[1]) {
                  await handleDownload(chatId, parts[1]);
                } else {
                  await sendTelegramMessage(
                    chatId,
                    "Usage: <code>/get &lt;filename&gt;</code>",
                  );
                }
              }
              break;
          }
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

startPolling();
