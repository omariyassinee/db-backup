#!/usr/bin/env node
import child_process from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import url from "node:url";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Metadata & Version
// ---------------------------------------------------------------------------

export const SCRIPT_VERSION = "1.1.0";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/**
 * Supported scopes for granular database backup and restore operations.
 */
export type BackupScope =
  "all" | "schema" | "data" | "roles" | "functions" | "rls";

/**
 * Output format of the backup archive:
 * - `custom`: PostgreSQL compressed custom archive format (`.dump`).
 * - `sql`: Plain-text SQL script (`.sql`).
 */
export type BackupFormat = "custom" | "sql";

/**
 * Error code classification for database backup and restore failures.
 */
export type BackupErrorCode =
  | "MISSING_URL"
  | "INVALID_URL"
  | "BINARY_NOT_FOUND"
  | "FILE_NOT_FOUND"
  | "PROCESS_FAILED"
  | "EXTRACTION_FAILED"
  | "RESTORE_ABORTED"
  | "INVALID_ARGUMENT";

/**
 * Custom error class representing database backup or restore errors.
 */
export class DatabaseBackupError extends Error {
  /** Error classification code. */
  public readonly code: BackupErrorCode;
  /** Underlying cause if this error wrapped a lower-level exception. */
  public override readonly cause?: unknown;

  /**
   * Creates a new instance of DatabaseBackupError.
   *
   * @param message - Human-readable error description.
   * @param code - Error code identifying the failure type.
   * @param cause - Optional underlying error or exception.
   */
  constructor(message: string, code: BackupErrorCode, cause?: unknown) {
    super(message);
    this.name = "DatabaseBackupError";
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Normalized database connection parameters and sanitized URLs.
 */
export interface DatabaseTarget {
  /** Complete raw connection URI. */
  rawUrl: string;
  /** Connection URI with password stripped out for safe logging and process arguments. */
  safeUrl: string;
  /** Connection URI with password masked with asterisks for safe CLI output. */
  maskedUrl: string;
  /** Database server hostname or IP address. */
  host: string;
  /** Database server port number. */
  port: string;
  /** Database name. */
  database: string;
  /** Authentication username. */
  user: string;
  /** Authentication password if provided. */
  password?: string;
}

/**
 * Execution context passed to backup option handlers.
 */
export interface BackupContext {
  /** Resolved database connection target. */
  db: DatabaseTarget;
  /** Directory where backup files will be saved. */
  outputDir: string;
  /** Requested archive format. */
  format: BackupFormat;
  /** Formatted timestamp string for the current backup run. */
  timestamp: string;
}

/**
 * Execution context passed to restore option handlers.
 */
export interface RestoreContext {
  /** Resolved database connection target. */
  db: DatabaseTarget;
  /** Absolute path to the backup file to restore. */
  filePath: string;
  /** Detected or user-specified backup scope. */
  scope: BackupScope | "unknown";
  /** Whether the backup file is in PostgreSQL custom archive format. */
  isCustomFormat: boolean;
}

/**
 * Definition of a backup scope handler with backup and restore implementations.
 */
export interface BackupOptionDefinition {
  /** Unique scope identifier. */
  id: BackupScope;
  /** Human-readable display name. */
  name: string;
  /** Command line flag corresponding to this scope. */
  flag: string;
  /** Detailed description of what this scope captures. */
  description: string;
  /** Default preferred output format for this scope. */
  preferredFormat: BackupFormat;
  /**
   * Executes backup extraction for this scope.
   *
   * @param ctx - Backup execution context.
   * @param targetPath - Destination file path for the archive.
   */
  backup: (ctx: BackupContext, targetPath: string) => Promise<void>;
  /**
   * Restores a backup archive for this scope.
   *
   * @param ctx - Restore execution context.
   */
  restore: (ctx: RestoreContext) => Promise<void>;
}

/**
 * Options for configuring Telegram backup notifications and document attachments.
 */
export interface TelegramOptions {
  /** Telegram Bot API token. */
  botToken: string;
  /** Destination chat, group, or channel ID. */
  chatId: string;
  /** Optional forum topic / thread ID within a supergroup. */
  threadId?: number;
  /** Attach generated backup archives directly when under Telegram's 50 MB limit. */
  sendFiles?: boolean;
}

/**
 * Options for configuring database backup operations.
 */
export interface BackupOptions {
  /** PostgreSQL connection URL. Falls back to DATABASE_ROOT_URL if omitted. */
  url?: string;
  /** Array of scopes to back up. Defaults to `['all']`. */
  scopes?: BackupScope[];
  /** Preferred archive format ('custom' or 'sql'). */
  format?: BackupFormat;
  /** Destination directory for backup files (defaults to `backup/db`). */
  dir?: string;
  /** Explicit output filename when backing up a single scope. */
  file?: string;
  /** Retention window in days (deletes backups older than N days). */
  retentionDays?: number;
  /** Retention limit by count (keeps the N newest backups per scope). */
  retentionCount?: number;
  /** Healthchecks.io or dead man's switch ping endpoint URL. */
  pingUrl?: string;
  /** Webhook URL for backup notifications (Discord, Slack, generic JSON). */
  webhookUrl?: string;
  /** Telegram configuration for backup notifications and optional document attachments. */
  telegram?: TelegramOptions;
  /** Optional progress callback invoked before and after backing up each scope. */
  onProgress?: (event: {
    phase: "start" | "complete";
    scope: BackupScope;
    result?: BackupResult;
  }) => void;
}

/**
 * Backup options specialized for single-scope backup helper functions.
 */
export type SingleScopeBackupOptions = Omit<BackupOptions, "scopes">;

/**
 * Summary result of a completed scope backup operation.
 */
export interface BackupResult {
  /** Scope that was backed up. */
  scope: BackupScope;
  /** Format of the generated archive. */
  format: BackupFormat;
  /** Full path to the generated backup archive file. */
  filePath: string;
  /** File size in bytes. */
  bytes: number;
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** Formatted timestamp string of the backup run. */
  timestamp: string;
}

/**
 * Result of a prune retention cleanup operation.
 */
export interface PruneResult {
  /** Filenames of deleted backup archives. */
  deletedFiles: string[];
  /** Total disk bytes reclaimed by pruning. */
  freedBytes: number;
}

/**
 * Options for configuring database restore operations.
 */
export interface RestoreOptions {
  /** PostgreSQL connection URL. Falls back to DATABASE_ROOT_URL if omitted. */
  url?: string;
  /** Path to the backup file to restore. */
  file?: string;
  /** Directory to search for backups when `latest` is true. */
  dir?: string;
  /** When true, automatically selects the most recent backup in the directory. */
  latest?: boolean;
  /** Explicit scope override if auto-detection should be bypassed. */
  scope?: BackupScope;
}

/**
 * Summary result of a completed database restoration.
 */
export interface RestoreResult {
  /** Path of the restored backup file. */
  filePath: string;
  /** Restored scope (or 'unknown' if not recognized). */
  scope: BackupScope | "unknown";
  /** Format of the restored archive. */
  format: BackupFormat;
  /** File size in bytes. */
  bytes: number;
  /** Total restore execution time in milliseconds. */
  durationMs: number;
}

/**
 * Metadata about an existing backup file on disk.
 */
export interface BackupFileInfo {
  /** Base filename of the backup archive. */
  filename: string;
  /** Absolute path to the backup file. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** File modification timestamp. */
  mtime: Date;
  /** Detected backup scope. */
  scope: BackupScope | "unknown";
  /** Detected archive format. */
  format: BackupFormat;
}

// ---------------------------------------------------------------------------
// Internal Utilities & Zero-Dependency Helpers
// ---------------------------------------------------------------------------

/**
 * Loads environment variables from an unquoted or quoted `.env` file if present.
 * Does not overwrite existing environment variables.
 */
export function loadDotEnv(envPath?: string): void {
  const candidatePaths: string[] = [];
  if (envPath) {
    candidatePaths.push(path.resolve(process.cwd(), envPath));
  } else {
    candidatePaths.push(path.resolve(process.cwd(), ".env"));
    try {
      const scriptDir = path.dirname(url.fileURLToPath(import.meta.url));
      candidatePaths.push(path.resolve(scriptDir, ".env"));
    } catch {
      // Ignore if fileURLToPath is unavailable
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
        // Silently continue if reading fails
      }
    }
  }
}

/**
 * Formats a byte count into a human-readable string representation (e.g. "1.50 MB").
 *
 * @param bytes - Number of bytes to format.
 * @returns Formatted file size string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
}

/**
 * Formats a Date object into a filesystem-safe timestamp string (`YYYY-MM-DD_HH-mm-ss`).
 *
 * @param date - Date to format.
 * @returns Formatted timestamp string.
 */
export function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/**
 * Parses and sanitizes a PostgreSQL connection URL into component parts and masked variants.
 *
 * @param rawUrl - Raw PostgreSQL connection URI.
 * @returns Structured and sanitized database connection target.
 * @throws {DatabaseBackupError} If the URL is missing, invalid, or malformed.
 */
export function parseDatabaseUrl(rawUrl: string): DatabaseTarget {
  const trimmed = rawUrl.trim();
  if (!/^postgres(?:ql)?:\/\//i.test(trimmed)) {
    throw new DatabaseBackupError(
      "Invalid PostgreSQL URI scheme. Expected postgres:// or postgresql://.",
      "INVALID_URL",
    );
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname || "localhost";
    const port = parsed.port || "5432";
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    const user = decodeURIComponent(parsed.username || "postgres");
    const password = parsed.password
      ? decodeURIComponent(parsed.password)
      : undefined;

    if (!database) {
      throw new DatabaseBackupError(
        "Database name is missing from connection URL.",
        "INVALID_URL",
      );
    }

    const safeParsed = new URL(trimmed);
    safeParsed.password = "";
    const safeUrl = safeParsed.toString();

    const maskedParsed = new URL(trimmed);
    if (maskedParsed.password) {
      maskedParsed.password = "****";
    }
    const maskedUrl = maskedParsed.toString();

    return {
      rawUrl: trimmed,
      safeUrl,
      maskedUrl,
      host,
      port,
      database,
      user,
      password,
    };
  } catch (err) {
    if (err instanceof DatabaseBackupError) throw err;
    throw new DatabaseBackupError(
      "Malformed PostgreSQL connection URL.",
      "INVALID_URL",
      err,
    );
  }
}

/**
 * Resolves the database target from an explicit URL string or the DATABASE_ROOT_URL env var.
 *
 * @param explicitUrl - Optional connection string passed by the caller.
 * @returns Parsed and validated database target.
 * @throws {DatabaseBackupError} If no database URL is provided or found in the environment.
 */
export function resolveDatabaseUrl(explicitUrl?: string): DatabaseTarget {
  const rawUrl = explicitUrl?.trim() || process.env.DATABASE_ROOT_URL?.trim();
  if (!rawUrl) {
    throw new DatabaseBackupError(
      "Database connection URL not provided. Pass `url` via options/--url or set DATABASE_ROOT_URL.",
      "MISSING_URL",
    );
  }
  return parseDatabaseUrl(rawUrl);
}

/**
 * Constructs the environment variable dictionary for spawned PostgreSQL subprocesses.
 * Sets `PGPASSWORD` and `PGSSLMODE` while preserving the host environment.
 *
 * @param db - Database connection target.
 * @returns Process environment object.
 */
function buildSpawnEnv(db: DatabaseTarget): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGSSLMODE: process.env.PGSSLMODE || "prefer",
  };
  if (db.password) {
    env.PGPASSWORD = db.password;
  }
  return env;
}

/**
 * Asserts that a required CLI binary (such as `pg_dump`, `pg_restore`, `psql`) exists on PATH.
 *
 * @param binary - Name of the executable to check.
 * @throws {DatabaseBackupError} If the binary cannot be located on PATH.
 */
function assertBinaryExists(binary: string): void {
  const locator = process.platform === "win32" ? "where" : "which";
  const check = child_process.spawnSync(locator, [binary], { stdio: "ignore" });
  if (check.status !== 0) {
    throw new DatabaseBackupError(
      `Required PostgreSQL client binary "${binary}" was not found on PATH. ` +
        `Please install postgresql-client (e.g. sudo apt install postgresql-client).`,
      "BINARY_NOT_FOUND",
    );
  }
}

/**
 * Execution options for spawning child command processes.
 */
interface SpawnExecutionOptions {
  /** Database target containing credentials and connection parameters. */
  db: DatabaseTarget;
  /** Optional standard input string to pipe into the process. */
  input?: string;
  /** Optional file path whose contents are streamed directly to process stdin. */
  streamFilePath?: string;
  /** Optional preamble SQL string sent before streaming file contents. */
  preamble?: string;
  /** Optional epilogue SQL string sent after streaming file contents. */
  epilogue?: string;
  /** Whether to capture and return process stdout instead of ignoring it. */
  captureStdout?: boolean;
}

/**
 * Executes an external binary as a child process and returns stdout upon completion.
 *
 * @param command - Command executable name or path.
 * @param args - Command line arguments passed to the binary.
 * @param options - Execution and streaming options.
 * @returns Standard output from the command as a string.
 * @throws {DatabaseBackupError} If the process fails to spawn or exits with a non-zero code.
 */
function runCommand(
  command: string,
  args: string[],
  options: SpawnExecutionOptions,
): Promise<string> {
  assertBinaryExists(command);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = child_process.spawn(command, args, {
      stdio: ["pipe", options.captureStdout ? "pipe" : "ignore", "pipe"],
      env: buildSpawnEnv(options.db),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (options.captureStdout && child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    }

    child.on("error", (err) => {
      rejectPromise(
        new DatabaseBackupError(
          `Failed to spawn ${command}: ${err.message}`,
          "PROCESS_FAILED",
          err,
        ),
      );
    });

    child.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
      if (code === 0) {
        resolvePromise(Buffer.concat(stdoutChunks).toString("utf-8"));
      } else {
        rejectPromise(
          new DatabaseBackupError(
            `${command} exited with code ${code}${stderr ? `: ${stderr}` : ""}`,
            "PROCESS_FAILED",
          ),
        );
      }
    });

    if (options.streamFilePath && child.stdin) {
      if (options.preamble) {
        child.stdin.write(options.preamble);
      }
      const stream = fs.createReadStream(options.streamFilePath);
      stream.on("error", (err) => {
        child.kill();
        rejectPromise(
          new DatabaseBackupError(
            `Failed reading stream file: ${err.message}`,
            "PROCESS_FAILED",
            err,
          ),
        );
      });
      stream.on("end", () => {
        if (options.epilogue) {
          child.stdin?.write(options.epilogue);
        }
        child.stdin?.end();
      });
      stream.pipe(child.stdin, { end: false });
    } else if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Healthcheck & Webhook Monitoring (Zero-Dependency)
// ---------------------------------------------------------------------------

/**
 * Sends a ping signal to a dead man's switch monitor (e.g. Healthchecks.io, Cronitor).
 * Supports start, success, and failure endpoints.
 *
 * @param status - Ping state ('start', 'success', 'fail').
 * @param pingUrl - Base ping URL.
 * @param message - Optional log or error message sent as the request body.
 */
export async function sendPing(
  status: "start" | "success" | "fail",
  pingUrl?: string,
  message?: string,
): Promise<void> {
  if (!pingUrl) return;

  let targetUrl = pingUrl.trim();
  if (status === "start") {
    targetUrl = targetUrl.endsWith("/")
      ? `${targetUrl}start`
      : `${targetUrl}/start`;
  } else if (status === "fail") {
    targetUrl = targetUrl.endsWith("/")
      ? `${targetUrl}fail`
      : `${targetUrl}/fail`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    await fetch(targetUrl, {
      method: message ? "POST" : "GET",
      headers: message
        ? { "Content-Type": "text/plain; charset=utf-8" }
        : undefined,
      body: message ? message : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    console.warn(
      `[db-backup] Healthcheck ping failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Sends an alert notification to a webhook endpoint (Discord, Slack, or generic JSON).
 *
 * @param webhookUrl - Webhook destination URL.
 * @param payload - Event details including status and human-readable message.
 */
export async function sendWebhook(
  webhookUrl?: string,
  payload?: {
    event: "success" | "failure";
    message: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  if (!webhookUrl || !payload) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const body = {
      content: `**[Database Backup]** ${payload.event.toUpperCase()}: ${payload.message}`,
      text: `[Database Backup] ${payload.event.toUpperCase()}: ${payload.message}`,
      event: payload.event,
      timestamp: new Date().toISOString(),
      details: payload.details,
    };

    await fetch(webhookUrl.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    console.warn(
      `[db-backup] Webhook notification failed: ${(err as Error).message}`,
    );
  }
}

const TELEGRAM_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB Bot API ceiling
const TELEGRAM_MAX_TEXT_LEN = 4096;
const TELEGRAM_MAX_CAPTION_LEN = 1024;

function escapeTelegramHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncateText(input: string, maxLen: number): string {
  return input.length <= maxLen ? input : `${input.slice(0, maxLen - 3)}...`;
}

export async function sendTelegram(
  config?: Partial<TelegramOptions>,
  payload?: {
    event: "success" | "failure";
    message: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  if (!config?.botToken || !config?.chatId || !payload) return;

  const statusLabel = payload.event === "success" ? "SUCCESS" : "FAILURE";
  let text = `<b>[Database Backup] ${statusLabel}</b>\n${escapeTelegramHtml(payload.message)}`;

  if (payload.details) {
    const lines = Object.entries(payload.details)
      .map(
        ([key, val]) =>
          `• <b>${escapeTelegramHtml(key)}:</b> <code>${escapeTelegramHtml(String(val))}</code>`,
      )
      .join("\n");
    text += `\n\n${lines}`;
  }

  const body: Record<string, unknown> = {
    chat_id: config.chatId.trim(),
    text: truncateText(text, TELEGRAM_MAX_TEXT_LEN),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  if (config.threadId !== undefined) {
    body.message_thread_id = config.threadId;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.botToken.trim()}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      console.warn(
        `[db-backup] Telegram sendMessage returned ${res.status}: ${await res.text()}`,
      );
    }
  } catch (err) {
    console.warn(
      `[db-backup] Telegram notification failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendTelegramDocument(
  config?: Partial<TelegramOptions>,
  filePath?: string,
  caption?: string,
): Promise<void> {
  if (!config?.botToken || !config?.chatId || !filePath) return;

  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > TELEGRAM_MAX_FILE_BYTES) {
      console.warn(
        `[db-backup] Skipping Telegram upload for ${path.basename(filePath)} (${formatBytes(stat.size)} exceeds 50 MB Bot API limit).`,
      );
      return;
    }

    const bytes = new Uint8Array(await fs.promises.readFile(filePath));
    const form = new FormData();
    form.append("chat_id", config.chatId.trim());
    form.append("document", new Blob([bytes]), path.basename(filePath));

    if (config.threadId !== undefined) {
      form.append("message_thread_id", String(config.threadId));
    }
    if (caption) {
      form.append("caption", truncateText(caption, TELEGRAM_MAX_CAPTION_LEN));
      form.append("parse_mode", "HTML");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${config.botToken.trim()}/sendDocument`,
        {
          method: "POST",
          body: form,
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        console.warn(
          `[db-backup] Telegram sendDocument returned ${res.status}: ${await res.text()}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn(
      `[db-backup] Telegram document upload failed: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Scope Definitions Registry
// ---------------------------------------------------------------------------

/**
 * Registry of supported backup scopes and their backup and restore implementations.
 */
export const BACKUP_OPTIONS: Record<BackupScope, BackupOptionDefinition> = {
  all: {
    id: "all",
    name: "Full Database Backup",
    flag: "--all",
    description:
      "Complete database dump: schemas, tables, views, routines, RLS policies, sequences, and data",
    preferredFormat: "custom",
    backup: async (ctx, targetPath) => {
      const args = [
        "-d",
        ctx.db.safeUrl,
        "-f",
        targetPath,
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
      ];
      if (ctx.format === "custom") args.push("-Fc");
      await runCommand("pg_dump", args, { db: ctx.db });
    },
    restore: async (ctx) => {
      if (ctx.isCustomFormat) {
        await runCommand(
          "pg_restore",
          [
            "-d",
            ctx.db.safeUrl,
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            ctx.filePath,
          ],
          { db: ctx.db },
        );
      } else {
        await runCommand(
          "psql",
          ["-d", ctx.db.safeUrl, "-v", "ON_ERROR_STOP=1", "-f", ctx.filePath],
          {
            db: ctx.db,
          },
        );
      }
    },
  },

  schema: {
    id: "schema",
    name: "Database Schema Only",
    flag: "--schema",
    description:
      "Dumps all DDL structures (tables, types, views, constraints, functions, policies) without row data",
    preferredFormat: "sql",
    backup: async (ctx, targetPath) => {
      const args = [
        "-d",
        ctx.db.safeUrl,
        "-f",
        targetPath,
        "--schema-only",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
      ];
      if (ctx.format === "custom") args.push("-Fc");
      await runCommand("pg_dump", args, { db: ctx.db });
    },
    restore: async (ctx) => {
      if (ctx.isCustomFormat) {
        await runCommand(
          "pg_restore",
          [
            "-d",
            ctx.db.safeUrl,
            "--schema-only",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            ctx.filePath,
          ],
          { db: ctx.db },
        );
      } else {
        await runCommand(
          "psql",
          ["-d", ctx.db.safeUrl, "-v", "ON_ERROR_STOP=1", "-f", ctx.filePath],
          {
            db: ctx.db,
          },
        );
      }
    },
  },

  data: {
    id: "data",
    name: "Table Data Only",
    flag: "--data",
    description:
      "Dumps all table row contents without dropping or recreating schema structures",
    preferredFormat: "custom",
    backup: async (ctx, targetPath) => {
      const args = [
        "-d",
        ctx.db.safeUrl,
        "-f",
        targetPath,
        "--data-only",
        "--no-owner",
        "--no-privileges",
      ];
      if (ctx.format === "custom") {
        args.push("-Fc");
      } else {
        args.push("--inserts");
      }
      await runCommand("pg_dump", args, { db: ctx.db });
    },
    restore: async (ctx) => {
      if (ctx.isCustomFormat) {
        await runCommand(
          "pg_restore",
          [
            "-d",
            ctx.db.safeUrl,
            "--data-only",
            "--disable-triggers",
            "--no-owner",
            "--no-privileges",
            ctx.filePath,
          ],
          { db: ctx.db },
        );
      } else {
        const preamble = `BEGIN;\nDO $$ BEGIN EXECUTE 'SET LOCAL session_replication_role = replica'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;\n`;
        const epilogue = `\nDO $$ BEGIN EXECUTE 'SET LOCAL session_replication_role = origin'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;\nCOMMIT;\n`;
        await runCommand(
          "psql",
          ["-d", ctx.db.safeUrl, "-v", "ON_ERROR_STOP=1"],
          {
            db: ctx.db,
            streamFilePath: ctx.filePath,
            preamble,
            epilogue,
          },
        );
      }
    },
  },

  roles: {
    id: "roles",
    name: "Roles & Memberships",
    flag: "--roles",
    description: "Dumps database roles, attributes, and role membership grants",
    preferredFormat: "sql",
    backup: async (ctx, targetPath) => {
      try {
        await runCommand(
          "pg_dumpall",
          [
            "-d",
            ctx.db.safeUrl,
            "--roles-only",
            "--clean",
            "--if-exists",
            "--no-role-passwords",
            "-f",
            targetPath,
          ],
          { db: ctx.db },
        );
        return;
      } catch {
        // Fallback to catalog inspection when lacking superuser permissions on managed instances
      }

      const rolesQuery = `
SELECT
  'DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ' || quote_literal(rolname) || ') THEN ' ||
  'CREATE ROLE ' || quote_ident(rolname) || ' WITH ' ||
  CASE WHEN rolcanlogin THEN 'LOGIN ' ELSE 'NOLOGIN ' END ||
  CASE WHEN rolinherit THEN 'INHERIT ' ELSE 'NOINHERIT ' END ||
  CASE WHEN rolcreatedb THEN 'CREATEDB ' ELSE 'NOCREATEDB ' END ||
  CASE WHEN rolcreaterole THEN 'CREATEROLE ' ELSE 'NOCREATEROLE ' END ||
  CASE WHEN rolreplication THEN 'REPLICATION ' ELSE 'NOREPLICATION ' END ||
  CASE WHEN rolbypassrls THEN 'BYPASSRLS ' ELSE 'NOBYPASSRLS ' END ||
  'CONNECTION LIMIT ' || rolconnlimit || ';' ||
  ' END IF; END $do$;'
FROM pg_catalog.pg_roles
WHERE rolname NOT LIKE 'pg_%'
  AND rolname NOT LIKE 'rds%'
  AND rolname NOT LIKE 'neon%'
  AND rolname NOT IN ('postgres', 'root', 'supabase_admin')
ORDER BY rolname;

SELECT
  'GRANT ' || quote_ident(r.rolname) || ' TO ' || quote_ident(m.rolname) ||
  CASE WHEN a.admin_option THEN ' WITH ADMIN OPTION;' ELSE ';' END
FROM pg_catalog.pg_auth_members a
JOIN pg_catalog.pg_roles r ON a.roleid = r.oid
JOIN pg_catalog.pg_roles m ON a.member = m.oid
WHERE r.rolname NOT LIKE 'pg_%'
  AND m.rolname NOT LIKE 'pg_%'
  AND r.rolname NOT IN ('postgres', 'root')
  AND m.rolname NOT IN ('postgres', 'root')
ORDER BY r.rolname, m.rolname;
`;

      const stdout = await runCommand(
        "psql",
        [
          "-d",
          ctx.db.safeUrl,
          "-v",
          "ON_ERROR_STOP=1",
          "-t",
          "-A",
          "-c",
          rolesQuery,
        ],
        { db: ctx.db, captureStdout: true },
      );

      const header = `-- Database Roles & Memberships Backup\n-- Extracted on ${new Date().toISOString()}\n\n`;
      const body = stdout.trim();
      await fs.promises.writeFile(
        targetPath,
        header + (body ? `${body}\n` : "-- No custom roles found.\n"),
        "utf-8",
      );
    },
    restore: async (ctx) => {
      await runCommand(
        "psql",
        ["-d", ctx.db.safeUrl, "-v", "ON_ERROR_STOP=1", "-f", ctx.filePath],
        {
          db: ctx.db,
        },
      );
    },
  },

  functions: {
    id: "functions",
    name: "Stored Routines & Triggers",
    flag: "--functions",
    description:
      "Dumps user-defined functions, procedures, and non-internal table triggers",
    preferredFormat: "sql",
    backup: async (ctx, targetPath) => {
      const extractQuery = `
SELECT pg_catalog.pg_get_functiondef(p.oid) || E';\\n'
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
LEFT JOIN pg_catalog.pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND p.prokind IN ('f', 'p')
  AND d.objid IS NULL
ORDER BY p.oid;

SELECT
  'DROP TRIGGER IF EXISTS ' || quote_ident(t.tgname) || ' ON ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || E';\\n' ||
  pg_catalog.pg_get_triggerdef(t.oid, true) || E';\\n'
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON t.tgrelid = c.oid
JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
WHERE NOT t.tgisinternal
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, c.relname, t.tgname;
`;

      const stdout = await runCommand(
        "psql",
        [
          "-d",
          ctx.db.safeUrl,
          "-v",
          "ON_ERROR_STOP=1",
          "-t",
          "-A",
          "-c",
          extractQuery,
        ],
        { db: ctx.db, captureStdout: true },
      );

      const header = `-- User-Defined Functions, Procedures & Triggers Backup\n-- Extracted on ${new Date().toISOString()}\n\n`;
      const body = stdout.trim();
      await fs.promises.writeFile(
        targetPath,
        header + (body ? `${body}\n` : "-- No custom routines found.\n"),
        "utf-8",
      );
    },
    restore: async (ctx) => {
      await runCommand(
        "psql",
        ["-d", ctx.db.safeUrl, "-v", "ON_ERROR_STOP=1", "-f", ctx.filePath],
        {
          db: ctx.db,
        },
      );
    },
  },

  rls: {
    id: "rls",
    name: "Row-Level Security (RLS) Policies",
    flag: "--rls",
    description:
      "Dumps table RLS enablement/enforcement flags and security policies",
    preferredFormat: "sql",
    backup: async (ctx, targetPath) => {
      const rlsQuery = `
SELECT
  'ALTER TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ' ENABLE ROW LEVEL SECURITY;' ||
  CASE WHEN c.relforcerowsecurity THEN E'\\nALTER TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ' FORCE ROW LEVEL SECURITY;' ELSE '' END
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
WHERE c.relkind IN ('r', 'p')
  AND c.relrowsecurity = true
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, c.relname;

SELECT
  'DROP POLICY IF EXISTS ' || quote_ident(p.polname) || ' ON ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || E';\\n' ||
  'CREATE POLICY ' || quote_ident(p.polname) || ' ON ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) ||
  ' AS ' || CASE p.polpermissive WHEN true THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END ||
  ' FOR ' || CASE p.polcmd
    WHEN 'r' THEN 'SELECT'
    WHEN 'a' THEN 'INSERT'
    WHEN 'w' THEN 'UPDATE'
    WHEN 'd' THEN 'DELETE'
    WHEN '*' THEN 'ALL'
  END ||
  ' TO ' || CASE
    WHEN p.polroles = '{0}' THEN 'PUBLIC'
    ELSE array_to_string(ARRAY(SELECT quote_ident(rolname) FROM pg_catalog.pg_roles WHERE oid = ANY(p.polroles)), ', ')
  END ||
  CASE WHEN p.polqual IS NOT NULL THEN ' USING (' || pg_catalog.pg_get_expr(p.polqual, p.polrelid) || ')' ELSE '' END ||
  CASE WHEN p.polwithcheck IS NOT NULL THEN ' WITH CHECK (' || pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) || ')' ELSE '' END ||
  ';'
FROM pg_catalog.pg_policy p
JOIN pg_catalog.pg_class c ON p.polrelid = c.oid
JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, c.relname, p.polname;
`;

      const stdout = await runCommand(
        "psql",
        [
          "-d",
          ctx.db.safeUrl,
          "-v",
          "ON_ERROR_STOP=1",
          "-t",
          "-A",
          "-c",
          rlsQuery,
        ],
        { db: ctx.db, captureStdout: true },
      );

      const header = `-- Row-Level Security (RLS) Policies Backup\n-- Extracted on ${new Date().toISOString()}\n\n`;
      const body = stdout.trim();
      await fs.promises.writeFile(
        targetPath,
        header + (body ? `${body}\n` : "-- No RLS policies found.\n"),
        "utf-8",
      );
    },
    restore: async (ctx) => {
      await runCommand(
        "psql",
        ["-d", ctx.db.safeUrl, "-v", "ON_ERROR_STOP=1", "-f", ctx.filePath],
        {
          db: ctx.db,
        },
      );
    },
  },
};

/**
 * List of all available backup scope identifiers.
 */
export const AVAILABLE_SCOPES = Object.keys(BACKUP_OPTIONS) as BackupScope[];

// ---------------------------------------------------------------------------
// Archive Inspection & Retention Pruning
// ---------------------------------------------------------------------------

/**
 * Checks whether a file starts with the PostgreSQL custom archive magic header (`PGDMP`).
 *
 * @param filePath - Path to the file to inspect.
 * @returns True if the file is in PostgreSQL custom archive format, false otherwise.
 */
function isPgCustomArchive(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(5);
    const bytesRead = fs.readSync(fd, buffer, 0, 5, 0);
    return bytesRead === 5 && buffer.toString("utf-8") === "PGDMP";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Inspects a backup file to detect its intended scope and archive format.
 *
 * @param filePath - Path to the backup archive.
 * @returns Detected scope and whether the file is in custom archive format.
 */
export function detectScopeAndFormat(filePath: string): {
  scope: BackupScope | "unknown";
  isCustomFormat: boolean;
} {
  const filename = path.basename(filePath).toLowerCase();
  let scope: BackupScope | "unknown" = "unknown";

  for (const candidate of AVAILABLE_SCOPES) {
    if (
      filename.includes(`_${candidate}_`) ||
      filename.endsWith(`_${candidate}.dump`) ||
      filename.endsWith(`_${candidate}.sql`)
    ) {
      scope = candidate;
      break;
    }
  }

  if (scope === "unknown") {
    for (const candidate of AVAILABLE_SCOPES) {
      if (filename.includes(candidate)) {
        scope = candidate;
        break;
      }
    }
  }

  const isCustomFormat =
    isPgCustomArchive(filePath) ||
    filename.endsWith(".dump") ||
    filename.endsWith(".backup") ||
    filename.endsWith(".tar");

  return { scope, isCustomFormat };
}

/**
 * Lists and inspects available backup archives in the target directory.
 *
 * @param dir - Directory containing backup archives (defaults to `backup/db`).
 * @returns Sorted list of backup file metadata (newest first).
 */
export function listBackups(dir = "backup/db"): BackupFileInfo[] {
  const targetDir = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(targetDir)) return [];

  return fs
    .readdirSync(targetDir)
    .filter(
      (f) => f.endsWith(".dump") || f.endsWith(".sql") || f.endsWith(".backup"),
    )
    .map((filename) => {
      const fullPath = path.join(targetDir, filename);
      const st = fs.statSync(fullPath);
      const { scope, isCustomFormat } = detectScopeAndFormat(fullPath);
      return {
        filename,
        path: fullPath,
        size: st.size,
        mtime: st.mtime,
        scope,
        format: (isCustomFormat ? "custom" : "sql") as BackupFormat,
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/**
 * Prunes old backup archives according to retention days and/or retention count limits.
 *
 * @param options - Pruning configuration parameters.
 * @returns List of deleted files and total bytes reclaimed.
 */
export function pruneBackups(options: {
  dir?: string;
  scope?: BackupScope;
  retentionDays?: number;
  retentionCount?: number;
}): PruneResult {
  const targetDir = path.resolve(process.cwd(), options.dir || "backup/db");
  if (!fs.existsSync(targetDir)) return { deletedFiles: [], freedBytes: 0 };

  const allFiles = listBackups(targetDir);
  const files = options.scope
    ? allFiles.filter((f) => f.scope === options.scope)
    : allFiles;

  const toDelete = new Set<BackupFileInfo>();
  const now = Date.now();

  // Prune by age (days)
  if (options.retentionDays && options.retentionDays > 0) {
    const maxAgeMs = options.retentionDays * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (now - file.mtime.getTime() > maxAgeMs) {
        toDelete.add(file);
      }
    }
  }

  // Prune by count (keep newest N files)
  if (options.retentionCount && options.retentionCount > 0) {
    if (files.length > options.retentionCount) {
      const excess = files.slice(options.retentionCount);
      for (const file of excess) {
        toDelete.add(file);
      }
    }
  }

  const deletedFiles: string[] = [];
  let freedBytes = 0;

  for (const file of toDelete) {
    try {
      fs.unlinkSync(file.path);
      deletedFiles.push(file.filename);
      freedBytes += file.size;
    } catch (err) {
      console.warn(
        `[db-backup] Could not delete old backup file ${file.filename}:`,
        err,
      );
    }
  }

  return { deletedFiles, freedBytes };
}

// ---------------------------------------------------------------------------
// Programmatic API
// ---------------------------------------------------------------------------

/**
 * Performs a database backup for one or more requested scopes.
 *
 * @param options - Backup configuration options.
 * @returns Array of backup results for each executed scope.
 * @throws {DatabaseBackupError} If backup execution fails or arguments are invalid.
 */
export async function backupDatabase(
  options: BackupOptions = {},
): Promise<BackupResult[]> {
  const db = resolveDatabaseUrl(options.url);
  const scopes: BackupScope[] =
    options.scopes && options.scopes.length > 0 ? options.scopes : ["all"];
  const outputDir = path.resolve(process.cwd(), options.dir || "backup/db");

  for (const scope of scopes) {
    if (!BACKUP_OPTIONS[scope]) {
      throw new DatabaseBackupError(
        `Unsupported backup scope: "${scope}".`,
        "INVALID_ARGUMENT",
      );
    }
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = formatDate(new Date());
  const results: BackupResult[] = [];

  for (const scope of scopes) {
    const definition = BACKUP_OPTIONS[scope];
    const format = options.format || definition.preferredFormat;
    const ext = format === "custom" ? "dump" : "sql";
    const filename =
      options.file && scopes.length === 1
        ? options.file
        : `backup_${scope}_${timestamp}.${ext}`;
    const targetPath = path.resolve(outputDir, filename);

    options.onProgress?.({ phase: "start", scope });
    const startTime = performance.now();

    await definition.backup(
      {
        db,
        outputDir,
        format,
        timestamp,
      },
      targetPath,
    );

    const durationMs = Math.round(performance.now() - startTime);
    const stats = fs.statSync(targetPath);

    const result: BackupResult = {
      scope,
      format,
      filePath: targetPath,
      bytes: stats.size,
      durationMs,
      timestamp,
    };

    results.push(result);
    options.onProgress?.({ phase: "complete", scope, result });
  }

  // Automatic retention pruning if configured
  if (options.retentionDays || options.retentionCount) {
    for (const scope of scopes) {
      pruneBackups({
        dir: outputDir,
        scope,
        retentionDays: options.retentionDays,
        retentionCount: options.retentionCount,
      });
    }
  }

  return results;
}

/**
 * Helper to run a backup operation for a single scope and return its result.
 *
 * @param scope - Scope to back up.
 * @param options - Single-scope backup options.
 * @returns Backup result for the scope.
 * @throws {DatabaseBackupError} If backup yields no output.
 */
async function runSingleScopeBackup(
  scope: BackupScope,
  options: SingleScopeBackupOptions = {},
): Promise<BackupResult> {
  const [result] = await backupDatabase({ ...options, scopes: [scope] });
  if (!result) {
    throw new DatabaseBackupError(
      `Backup execution yielded no output for scope "${scope}".`,
      "PROCESS_FAILED",
    );
  }
  return result;
}

/**
 * Backs up the entire database including DDL structures and row data.
 */
export const backupAll = (
  options?: SingleScopeBackupOptions,
): Promise<BackupResult> => runSingleScopeBackup("all", options);

/**
 * Backs up database schema structures (tables, views, routines, RLS, enums) without row data.
 */
export const backupSchema = (
  options?: SingleScopeBackupOptions,
): Promise<BackupResult> => runSingleScopeBackup("schema", options);

/**
 * Backs up table row contents only without dropping or recreating schema structures.
 */
export const backupData = (
  options?: SingleScopeBackupOptions,
): Promise<BackupResult> => runSingleScopeBackup("data", options);

/**
 * Backs up database roles, attributes, and role memberships.
 */
export const backupRoles = (
  options?: SingleScopeBackupOptions,
): Promise<BackupResult> => runSingleScopeBackup("roles", options);

/**
 * Backs up user-defined functions, stored procedures, and triggers.
 */
export const backupFunctions = (
  options?: SingleScopeBackupOptions,
): Promise<BackupResult> => runSingleScopeBackup("functions", options);

/**
 * Backs up Row-Level Security (RLS) enablement flags and security policies.
 */
export const backupRls = (
  options?: SingleScopeBackupOptions,
): Promise<BackupResult> => runSingleScopeBackup("rls", options);

/**
 * Restores a database backup from a specified archive file or the latest backup.
 *
 * @param options - Restore options specifying target file or directory.
 * @returns Restore operation results and timing.
 * @throws {DatabaseBackupError} If target file is missing, does not exist, or restore fails.
 */
export async function restoreDatabase(
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const db = resolveDatabaseUrl(options.url);
  const targetDir = path.resolve(process.cwd(), options.dir || "backup/db");

  let targetFile = options.file
    ? path.resolve(process.cwd(), options.file)
    : undefined;

  if (!targetFile && options.latest) {
    const backups = listBackups(targetDir);
    targetFile = backups[0]?.path;
  }

  if (!targetFile) {
    throw new DatabaseBackupError(
      "No backup file specified. Provide `file` or set `latest: true`.",
      "INVALID_ARGUMENT",
    );
  }

  if (!fs.existsSync(targetFile)) {
    throw new DatabaseBackupError(
      `Backup file does not exist: ${targetFile}`,
      "FILE_NOT_FOUND",
    );
  }

  const stats = fs.statSync(targetFile);
  const detected = detectScopeAndFormat(targetFile);
  const scope = options.scope || detected.scope;
  const isCustomFormat = detected.isCustomFormat;

  const startTime = performance.now();
  const ctx: RestoreContext = {
    db,
    filePath: targetFile,
    scope,
    isCustomFormat,
  };

  if (scope !== "unknown" && BACKUP_OPTIONS[scope]) {
    await BACKUP_OPTIONS[scope].restore(ctx);
  } else if (isCustomFormat) {
    await runCommand(
      "pg_restore",
      [
        "-d",
        db.safeUrl,
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        targetFile,
      ],
      { db },
    );
  } else {
    await runCommand(
      "psql",
      ["-d", db.safeUrl, "-v", "ON_ERROR_STOP=1", "-f", targetFile],
      { db },
    );
  }

  return {
    filePath: targetFile,
    scope,
    format: isCustomFormat ? "custom" : "sql",
    bytes: stats.size,
    durationMs: Math.round(performance.now() - startTime),
  };
}

// ---------------------------------------------------------------------------
// CLI Layer
// ---------------------------------------------------------------------------

/**
 * ANSI terminal escape sequences for styled command-line output.
 */
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

/**
 * Parsed command-line arguments structure.
 */
interface ParsedCliArgs {
  /** CLI command to execute. */
  command: "backup" | "restore" | "list" | "prune" | "help";
  /** Scopes selected for backup. */
  scopes: BackupScope[];
  /** Requested archive format. */
  format?: BackupFormat;
  /** Output or search directory for backup files. */
  dir: string;
  /** Explicit file path argument. */
  file?: string;
  /** PostgreSQL connection URL override. */
  url?: string;
  /** Retention limit in days. */
  retentionDays?: number;
  /** Retention limit by number of recent files. */
  retentionCount?: number;
  /** Dead man's switch ping URL (Healthchecks.io). */
  pingUrl?: string;
  /** Webhook notification URL. */
  webhookUrl?: string;
  /** Telegram Bot API token. */
  telegramBotToken?: string;
  /** Telegram destination chat ID. */
  telegramChatId?: string;
  /** Telegram topic thread ID. */
  telegramThreadId?: number;
  /** Whether to upload archives under 50MB to Telegram. */
  telegramSendFiles: boolean;
  /** Pre-supplied challenge response to bypass interactive prompt. */
  challengeOverride?: string;
  /** Whether to bypass confirmation prompts. */
  force: boolean;
  /** Whether to automatically pick the latest backup file for restore. */
  latest: boolean;
}

/**
 * Extracts the value portion of a `--flag=value` command-line argument.
 *
 * @param arg - Command line argument string.
 * @returns Extracted value or empty string if no `=` was found.
 */
function extractFlagValue(arg: string): string {
  const idx = arg.indexOf("=");
  return idx === -1 ? "" : arg.slice(idx + 1).trim();
}

/**
 * Parses raw command-line arguments into a structured `ParsedCliArgs` object.
 *
 * @param args - Raw argument strings from `process.argv.slice(2)`.
 * @returns Parsed CLI arguments.
 */
function parseCliArgs(args: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    command: "help",
    scopes: [],
    dir: path.resolve(process.cwd(), process.env.BACKUP_DIR || "backup/db"),
    force: false,
    latest: false,
    pingUrl: process.env.BACKUP_PING_URL,
    webhookUrl: process.env.BACKUP_WEBHOOK_URL,
    telegramBotToken: process.env.BACKUP_TELEGRAM_TOKEN,
    telegramChatId: process.env.BACKUP_TELEGRAM_CHAT_ID,
    telegramThreadId: process.env.BACKUP_TELEGRAM_THREAD_ID
      ? parseInt(process.env.BACKUP_TELEGRAM_THREAD_ID, 10)
      : undefined,
    telegramSendFiles: process.env.BACKUP_TELEGRAM_SEND_FILES === "true",
  };

  if (process.env.BACKUP_RETENTION_DAYS) {
    const days = parseInt(process.env.BACKUP_RETENTION_DAYS, 10);
    if (!isNaN(days) && days > 0) result.retentionDays = days;
  }

  if (process.env.BACKUP_RETENTION_COUNT) {
    const count = parseInt(process.env.BACKUP_RETENTION_COUNT, 10);
    if (!isNaN(count) && count > 0) result.retentionCount = count;
  }

  let positionalIndex = 0;

  for (const arg of args) {
    if (!arg) continue;

    if (arg === "backup" || arg === "b") {
      result.command = "backup";
      continue;
    }
    if (arg === "restore" || arg === "r") {
      result.command = "restore";
      continue;
    }
    if (arg === "list" || arg === "ls") {
      result.command = "list";
      continue;
    }
    if (arg === "prune" || arg === "cleanup") {
      result.command = "prune";
      continue;
    }
    if (arg === "help" || arg === "--help" || arg === "-h") {
      result.command = "help";
      continue;
    }

    if (arg === "--all" || arg === "-a") {
      if (!result.scopes.includes("all")) result.scopes.push("all");
      continue;
    }
    if (arg === "--schema" || arg === "-s") {
      if (!result.scopes.includes("schema")) result.scopes.push("schema");
      continue;
    }
    if (arg === "--data" || arg === "-d") {
      if (!result.scopes.includes("data")) result.scopes.push("data");
      continue;
    }
    if (arg === "--roles") {
      if (!result.scopes.includes("roles")) result.scopes.push("roles");
      continue;
    }
    if (arg === "--functions") {
      if (!result.scopes.includes("functions")) result.scopes.push("functions");
      continue;
    }
    if (arg === "--rls") {
      if (!result.scopes.includes("rls")) result.scopes.push("rls");
      continue;
    }

    if (arg.startsWith("--options=") || arg.startsWith("-o=")) {
      const parts = extractFlagValue(arg).split(",");
      for (const p of parts) {
        const candidate = p.trim().toLowerCase() as BackupScope;
        if (
          AVAILABLE_SCOPES.includes(candidate) &&
          !result.scopes.includes(candidate)
        ) {
          result.scopes.push(candidate);
        }
      }
      continue;
    }

    if (arg.startsWith("--format=")) {
      const f = extractFlagValue(arg).toLowerCase();
      if (f === "custom" || f === "sql") result.format = f;
      continue;
    }

    if (arg.startsWith("--dir=") || arg.startsWith("--out=")) {
      const val = extractFlagValue(arg);
      if (val) result.dir = path.resolve(process.cwd(), val);
      continue;
    }

    if (arg.startsWith("--file=")) {
      const val = extractFlagValue(arg);
      if (val) result.file = path.resolve(process.cwd(), val);
      continue;
    }

    if (arg.startsWith("--url=")) {
      const val = extractFlagValue(arg);
      if (val) result.url = val;
      continue;
    }

    // Retention configuration
    if (arg.startsWith("--retention=")) {
      const val = extractFlagValue(arg).toLowerCase();
      if (val.endsWith("d") || val.endsWith("days")) {
        const parsed = parseInt(val.replace(/[^\d]/g, ""), 10);
        if (!isNaN(parsed)) result.retentionDays = parsed;
      } else if (val.endsWith("c") || val.endsWith("files")) {
        const parsed = parseInt(val.replace(/[^\d]/g, ""), 10);
        if (!isNaN(parsed)) result.retentionCount = parsed;
      } else {
        const parsed = parseInt(val, 10);
        if (!isNaN(parsed)) result.retentionDays = parsed;
      }
      continue;
    }

    if (arg.startsWith("--retention-days=") || arg.startsWith("--keep-days=")) {
      const parsed = parseInt(extractFlagValue(arg), 10);
      if (!isNaN(parsed)) result.retentionDays = parsed;
      continue;
    }

    if (
      arg.startsWith("--retention-count=") ||
      arg.startsWith("--keep=") ||
      arg.startsWith("--keep-count=")
    ) {
      const parsed = parseInt(extractFlagValue(arg), 10);
      if (!isNaN(parsed)) result.retentionCount = parsed;
      continue;
    }

    // Monitoring configuration
    if (arg.startsWith("--ping-url=") || arg.startsWith("--ping=")) {
      result.pingUrl = extractFlagValue(arg);
      continue;
    }

    if (arg.startsWith("--webhook=") || arg.startsWith("--webhook-url=")) {
      result.webhookUrl = extractFlagValue(arg);
      continue;
    }

    if (arg.startsWith("--telegram-token=")) {
      result.telegramBotToken = extractFlagValue(arg);
      continue;
    }

    if (
      arg.startsWith("--telegram-chat-id=") ||
      arg.startsWith("--telegram-chat=")
    ) {
      result.telegramChatId = extractFlagValue(arg);
      continue;
    }

    if (arg.startsWith("--telegram-thread-id=")) {
      const parsed = parseInt(extractFlagValue(arg), 10);
      if (!isNaN(parsed)) result.telegramThreadId = parsed;
      continue;
    }

    if (arg === "--telegram-send-files") {
      result.telegramSendFiles = true;
      continue;
    }

    if (arg.startsWith("--challenge=")) {
      result.challengeOverride = extractFlagValue(arg);
      continue;
    }

    if (arg === "--force" || arg === "-f" || arg === "--yes" || arg === "-y") {
      result.force = true;
      continue;
    }

    if (arg === "--latest") {
      result.latest = true;
      continue;
    }

    if (
      !arg.startsWith("-") &&
      result.command === "restore" &&
      positionalIndex === 0
    ) {
      result.file = path.resolve(process.cwd(), arg);
      positionalIndex++;
    }
  }

  return result;
}

/**
 * Prompts the user interactively in the terminal with a challenge word confirmation.
 *
 * @param expected - Expected confirmation string (e.g. "restore").
 * @returns Promise resolving to true if user typed the expected string, false otherwise.
 */
function promptChallenge(expected: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolvePrompt) => {
    rl.question(
      `\n${ansi.bold}${ansi.red}CHALLENGE:${ansi.reset} Type ${ansi.bold}${ansi.yellow}"${expected}"${ansi.reset} to confirm destructive restore: `,
      (answer) => {
        rl.close();
        resolvePrompt(answer.trim() === expected);
      },
    );
  });
}

/**
 * Runs the CLI database backup flow with terminal reporting and progress indicators.
 *
 * @param args - Parsed CLI options.
 */
async function runCliBackup(args: ParsedCliArgs): Promise<void> {
  const db = resolveDatabaseUrl(args.url);
  const scopes: BackupScope[] = args.scopes.length > 0 ? args.scopes : ["all"];

  console.log(
    `\n${ansi.bold}${ansi.cyan}PostgreSQL Backup Runner v${SCRIPT_VERSION}${ansi.reset}`,
  );
  console.log(
    `${ansi.dim}Target Database:${ansi.reset}  ${ansi.bold}${db.database}${ansi.reset}`,
  );
  console.log(
    `${ansi.dim}Target Host:${ansi.reset}      ${db.host}:${db.port}`,
  );
  console.log(`${ansi.dim}Target User:${ansi.reset}      ${db.user}`);
  console.log(`${ansi.dim}Output Directory:${ansi.reset} ${args.dir}`);
  console.log(
    `${ansi.dim}Selected Scopes:${ansi.reset}  ${scopes.map((s) => `${ansi.magenta}${s}${ansi.reset}`).join(", ")}`,
  );

  if (args.retentionDays || args.retentionCount) {
    const policy = [
      args.retentionDays ? `${args.retentionDays} days` : "",
      args.retentionCount ? `keep ${args.retentionCount} newest` : "",
    ]
      .filter(Boolean)
      .join(", ");
    console.log(
      `${ansi.dim}Retention Policy:${ansi.reset} ${ansi.yellow}${policy}${ansi.reset}`,
    );
  }

  if (args.pingUrl) {
    console.log(
      `${ansi.dim}Healthcheck Ping:${ansi.reset} ${ansi.cyan}${args.pingUrl}${ansi.reset}`,
    );
  }
  console.log();

  // Send start ping to monitoring service
  await sendPing("start", args.pingUrl);

  try {
    const results = await backupDatabase({
      url: args.url,
      scopes,
      format: args.format,
      dir: args.dir,
      file: args.file,
      retentionDays: args.retentionDays,
      retentionCount: args.retentionCount,
      onProgress: ({ phase, scope, result }) => {
        const def = BACKUP_OPTIONS[scope];
        if (phase === "start") {
          process.stdout.write(
            `  Backing up ${ansi.bold}${def.name}${ansi.reset} [${ansi.magenta}${scope}${ansi.reset}]... `,
          );
        } else if (result) {
          const sec = (result.durationMs / 1000).toFixed(2);
          console.log(
            `${ansi.green}OK${ansi.reset} ${ansi.dim}(${formatBytes(result.bytes)}, ${sec}s)${ansi.reset}`,
          );
          console.log(`    ${ansi.dim}-> ${result.filePath}${ansi.reset}`);
        }
      },
    });

    // Prune reporting if retention was executed
    if (args.retentionDays || args.retentionCount) {
      for (const scope of scopes) {
        const pruneRes = pruneBackups({
          dir: args.dir,
          scope,
          retentionDays: args.retentionDays,
          retentionCount: args.retentionCount,
        });
        if (pruneRes.deletedFiles.length > 0) {
          console.log(
            `\n  ${ansi.yellow}Pruned ${pruneRes.deletedFiles.length} expired [${scope}] backup(s), freed ${formatBytes(pruneRes.freedBytes)}.${ansi.reset}`,
          );
        }
      }
    }

    console.log(
      `\n${ansi.green}${ansi.bold}Backup operation completed successfully.${ansi.reset}\n`,
    );

    const telegramConfig: Partial<TelegramOptions> = {
      botToken: args.telegramBotToken,
      chatId: args.telegramChatId,
      threadId: args.telegramThreadId,
      sendFiles: args.telegramSendFiles,
    };

    const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
    const summaryText = `Backup succeeded for ${db.database} (${results.length} scopes: ${scopes.join(", ")}).`;
    const details = {
      database: db.database,
      host: `${db.host}:${db.port}`,
      scopes: scopes.join(", "),
      size: formatBytes(totalBytes),
    };

    await Promise.allSettled([
      sendPing("success", args.pingUrl, summaryText),
      sendWebhook(args.webhookUrl, {
        event: "success",
        message: summaryText,
        details,
      }),
      sendTelegram(telegramConfig, {
        event: "success",
        message: summaryText,
        details,
      }),
    ]);

    if (
      telegramConfig.sendFiles &&
      telegramConfig.botToken &&
      telegramConfig.chatId
    ) {
      for (const res of results) {
        const caption = `<b>${escapeTelegramHtml(db.database)}</b> [${res.scope}] • ${formatBytes(res.bytes)}`;
        await sendTelegramDocument(telegramConfig, res.filePath, caption);
      }
    }
  } catch (err) {
    const errorMsg = (err as Error).message || "Unknown backup error";
    const failMessage = `Backup failed for ${db.database}: ${errorMsg}`;
    const failDetails = {
      database: db.database,
      host: `${db.host}:${db.port}`,
      error: errorMsg,
    };

    const telegramConfig: Partial<TelegramOptions> = {
      botToken: args.telegramBotToken,
      chatId: args.telegramChatId,
      threadId: args.telegramThreadId,
      sendFiles: args.telegramSendFiles,
    };

    await Promise.allSettled([
      sendPing("fail", args.pingUrl, failMessage),
      sendWebhook(args.webhookUrl, {
        event: "failure",
        message: failMessage,
        details: failDetails,
      }),
      sendTelegram(telegramConfig, {
        event: "failure",
        message: failMessage,
        details: failDetails,
      }),
    ]);
    throw err;
  }
}

/**
 * Runs the CLI database restore flow with confirmation safety challenges.
 *
 * @param args - Parsed CLI options.
 * @throws {DatabaseBackupError} If safety challenge fails or file is not found.
 */
async function runCliRestore(args: ParsedCliArgs): Promise<void> {
  const db = resolveDatabaseUrl(args.url);
  let targetFile = args.file;

  if (!targetFile && args.latest) {
    const backups = listBackups(args.dir);
    targetFile = backups[0]?.path;
  }

  if (!targetFile) {
    throw new DatabaseBackupError(
      `No backup file specified. Pass a file path or --latest.`,
      "INVALID_ARGUMENT",
    );
  }

  if (!fs.existsSync(targetFile)) {
    throw new DatabaseBackupError(
      `Backup file not found: ${targetFile}`,
      "FILE_NOT_FOUND",
    );
  }

  const stats = fs.statSync(targetFile);
  const { scope, isCustomFormat } = detectScopeAndFormat(targetFile);

  console.log(`\n${ansi.bold}${ansi.red}${"=".repeat(72)}${ansi.reset}`);
  console.log(
    `${ansi.bold}${ansi.yellow}DATABASE RESTORE CONFIRMATION${ansi.reset}`,
  );
  console.log(`${ansi.bold}${ansi.red}${"=".repeat(72)}${ansi.reset}`);
  console.log(
    `${ansi.dim}Target Database:${ansi.reset}  ${ansi.bold}${ansi.red}${db.database}${ansi.reset}`,
  );
  console.log(
    `${ansi.dim}Target Host:${ansi.reset}      ${ansi.bold}${db.host}:${db.port}${ansi.reset}`,
  );
  console.log(`${ansi.dim}Target User:${ansi.reset}      ${db.user}`);
  console.log(
    `${ansi.dim}Backup File:${ansi.reset}      ${ansi.bold}${path.basename(targetFile)}${ansi.reset}`,
  );
  console.log(
    `${ansi.dim}File Size:${ansi.reset}        ${formatBytes(stats.size)}`,
  );
  console.log(
    `${ansi.dim}Detected Scope:${ansi.reset}   ${ansi.magenta}${scope}${ansi.reset} ${ansi.dim}(${isCustomFormat ? "custom archive" : "plain SQL"})${ansi.reset}`,
  );
  console.log(`${ansi.bold}${ansi.red}${"=".repeat(72)}${ansi.reset}`);

  const challengeWord = "restore";
  let verified: boolean;

  if (args.challengeOverride !== undefined) {
    verified = args.challengeOverride === challengeWord;
  } else if (args.force) {
    verified = true;
  } else {
    verified = await promptChallenge(challengeWord);
  }

  if (!verified) {
    throw new DatabaseBackupError(
      "Restore challenge verification failed.",
      "RESTORE_ABORTED",
    );
  }

  const res = await restoreDatabase({
    url: args.url,
    file: targetFile,
    dir: args.dir,
  });

  console.log(
    `\n${ansi.green}${ansi.bold}Database restore completed in ${(res.durationMs / 1000).toFixed(2)}s.${ansi.reset}\n`,
  );
}

/**
 * Runs the CLI backup listing command to display available archives in a tabular format.
 *
 * @param args - Parsed CLI options containing the target directory.
 */
function runCliList(args: ParsedCliArgs): void {
  const files = listBackups(args.dir);

  console.log(
    `\n${ansi.bold}${ansi.cyan}Database Backups (${args.dir})${ansi.reset}\n`,
  );
  if (files.length === 0) {
    console.log(`  ${ansi.dim}No backup files found.${ansi.reset}\n`);
    return;
  }

  console.log(
    `  ${ansi.dim}${"FILENAME".padEnd(42)} ${"SCOPE".padEnd(12)} ${"FORMAT".padEnd(8)} ${"SIZE".padEnd(10)} ${"CREATED"}${ansi.reset}`,
  );
  console.log(`  ${"-".repeat(92)}`);

  for (const f of files) {
    const created = f.mtime.toISOString().replace("T", " ").slice(0, 19);
    console.log(
      `  ${ansi.bold}${f.filename.padEnd(42)}${ansi.reset} ${ansi.magenta}${f.scope.padEnd(12)}${ansi.reset} ${ansi.cyan}${f.format.padEnd(8)}${ansi.reset} ${formatBytes(f.size).padEnd(10)} ${ansi.dim}${created}${ansi.reset}`,
    );
  }

  console.log(`\n  ${ansi.dim}Total: ${files.length} backup(s)${ansi.reset}\n`);
}

/**
 * Runs the standalone CLI prune command to remove old backup archives on demand.
 *
 * @param args - Parsed CLI options.
 */
function runCliPrune(args: ParsedCliArgs): void {
  console.log(
    `\n${ansi.bold}${ansi.cyan}Database Backup Retention Pruner${ansi.reset}`,
  );
  console.log(`${ansi.dim}Target Directory:${ansi.reset} ${args.dir}`);

  if (!args.retentionDays && !args.retentionCount) {
    console.log(
      `\n${ansi.yellow}No retention rules specified. Use --retention=14d or --keep=7.${ansi.reset}\n`,
    );
    return;
  }

  const res = pruneBackups({
    dir: args.dir,
    retentionDays: args.retentionDays,
    retentionCount: args.retentionCount,
  });

  if (res.deletedFiles.length === 0) {
    console.log(
      `\n${ansi.green}No expired backup files to prune.${ansi.reset}\n`,
    );
  } else {
    console.log(
      `\n${ansi.yellow}Deleted ${res.deletedFiles.length} file(s):${ansi.reset}`,
    );
    for (const f of res.deletedFiles) {
      console.log(`  - ${f}`);
    }
    console.log(
      `\n${ansi.green}${ansi.bold}Total disk space freed:${ansi.reset} ${formatBytes(res.freedBytes)}\n`,
    );
  }
}

/**
 * Prints the CLI help and usage message to the terminal.
 */
function printHelp(): void {
  console.log(`
${ansi.bold}${ansi.cyan}PostgreSQL Backup & Restore CLI v${SCRIPT_VERSION}${ansi.reset}
${ansi.dim}Zero-dependency, standalone backup tool for PostgreSQL & Neon${ansi.reset}

${ansi.bold}USAGE:${ansi.reset}
  node db-backup.ts <command> [options]
  bun db-backup.ts <command> [options]

${ansi.bold}COMMANDS:${ansi.reset}
  ${ansi.green}backup${ansi.reset} (b)          Execute database backup for selected scopes
  ${ansi.green}restore${ansi.reset} (r)         Restore database from a backup archive
  ${ansi.green}list${ansi.reset} (ls)           List available backup archives
  ${ansi.green}prune${ansi.reset}               Prune old backups according to retention policy
  ${ansi.green}help${ansi.reset}                Display this help screen

${ansi.bold}SCOPES:${ansi.reset}
  ${ansi.magenta}--all${ansi.reset} (-a)            Full database dump (DDL + data)
  ${ansi.magenta}--schema${ansi.reset} (-s)         Schema-only dump (DDL without row data)
  ${ansi.magenta}--data${ansi.reset} (-d)           Table row data only
  ${ansi.magenta}--roles${ansi.reset}               Database roles and memberships (Neon-safe)
  ${ansi.magenta}--functions${ansi.reset}           User-defined routines and triggers
  ${ansi.magenta}--rls${ansi.reset}                 Row-Level Security flags and policies
  ${ansi.magenta}--options=<list>${ansi.reset}     Comma-delimited scopes (e.g. --options=schema,rls)

${ansi.bold}OPTIONS:${ansi.reset}
  ${ansi.cyan}--url=<connstr>${ansi.reset}       PostgreSQL connection URL (falls back to DATABASE_ROOT_URL)
  ${ansi.cyan}--dir=<path>${ansi.reset}          Target directory (default: backup/db or BACKUP_DIR)
  ${ansi.cyan}--format=<custom|sql>${ansi.reset} Archive format (custom .dump or plain .sql)
  ${ansi.cyan}--file=<path>${ansi.reset}         Explicit file path for single-scope backup/restore
  ${ansi.cyan}--latest${ansi.reset}              Select newest backup archive for restoration
  ${ansi.cyan}--force${ansi.reset} (-f)           Bypass interactive confirmation prompt
  ${ansi.cyan}--challenge=restore${ansi.reset}  Confirm restoration non-interactively

${ansi.bold}RETENTION & PRUNING:${ansi.reset}
  ${ansi.cyan}--retention=<14d|7c>${ansi.reset}  Retain by days (e.g. 14d) or count (e.g. 7c)
  ${ansi.cyan}--retention-days=<n>${ansi.reset}  Delete backups older than N days (or BACKUP_RETENTION_DAYS)
  ${ansi.cyan}--keep=<count>${ansi.reset}        Keep newest N backups per scope (or BACKUP_RETENTION_COUNT)

${ansi.bold}MONITORING & ALERTS:${ansi.reset}
  ${ansi.cyan}--ping-url=<url>${ansi.reset}      Healthchecks.io / Dead Man's Switch URL (or BACKUP_PING_URL)
  ${ansi.cyan}--webhook=<url>${ansi.reset}       Slack / Discord / JSON webhook URL (or BACKUP_WEBHOOK_URL)
  ${ansi.cyan}--telegram-token=<tok>${ansi.reset}     Telegram Bot API token (or BACKUP_TELEGRAM_TOKEN)
  ${ansi.cyan}--telegram-chat-id=<id>${ansi.reset}    Telegram chat/channel ID (or BACKUP_TELEGRAM_CHAT_ID)
  ${ansi.cyan}--telegram-thread-id=<id>${ansi.reset}  Telegram supergroup topic ID (or BACKUP_TELEGRAM_THREAD_ID)
  ${ansi.cyan}--telegram-send-files${ansi.reset}      Upload archives <50 MB to chat (or BACKUP_TELEGRAM_SEND_FILES=true)

${ansi.bold}VPS CRON EXAMPLE:${ansi.reset}
  0 2 * * * cd /opt/backup && bun db-backup.ts backup --all --retention=14d --ping-url=https://hc-ping.com/UUID
`);
}

/**
 * Main CLI entrypoint dispatcher parsing arguments and delegating to subcommands.
 */
async function runCli(): Promise<void> {
  loadDotEnv();
  const parsed = parseCliArgs(process.argv.slice(2));

  switch (parsed.command) {
    case "backup":
      await runCliBackup(parsed);
      break;
    case "restore":
      await runCliRestore(parsed);
      break;
    case "list":
      runCliList(parsed);
      break;
    case "prune":
      runCliPrune(parsed);
      break;
    default:
      printHelp();
      break;
  }
}

/**
 * Determines whether the script was executed directly from the command line.
 * Supports both Bun's `import.meta.main` and Node.js `process.argv[1]` resolution.
 *
 * @returns True if executed directly, false if imported as a library module.
 */
function isDirectExecution(): boolean {
  if ("main" in import.meta && typeof import.meta.main === "boolean") {
    return import.meta.main;
  }
  if (!process.argv[1]) return false;
  try {
    return (
      path.resolve(process.argv[1]) ===
      path.resolve(url.fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runCli().catch((err: unknown) => {
    if (err instanceof DatabaseBackupError) {
      console.error(
        `\n${ansi.red}Error [${err.code}]:${ansi.reset} ${err.message}\n`,
      );
    } else {
      console.error(`\n${ansi.red}Unhandled error:${ansi.reset}`, err);
    }
    process.exit(1);
  });
}
