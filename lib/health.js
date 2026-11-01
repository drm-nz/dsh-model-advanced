/**
 * Startup self-check reporting for dsh-model-advanced.
 *
 * Why this exists: this plugin decorates runtime prototypes and swallows every
 * failure so a broken seam can never break a turn. That also makes a broken seam
 * invisible — the settings card keeps rendering and saving while the defaults
 * quietly stop applying. The host does not persist logger output, so the result
 * is appended to a shared health log instead.
 *
 * The checks themselves live in index.js, which is the only place with access to
 * the decorated functions.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Shared health log; both custom plugins append to it. */
export const DEFAULT_HEALTH_FILE = join(homedir(), ".dsh", "health.log");

/** Plugin name as it appears in the log, padded so lines from both plugins align. */
export const NAME = "dsh-model-advanced";

/**
 * Append one health line. Never throws: a diagnostics failure must not stop the
 * plugin from loading.
 *
 * @param {{ status: "ok" | "warn" | "fail", detail: string }} result
 * @param {{ file?: string, now?: () => string }} [options]
 * @returns {boolean} whether the line was written.
 */
export function report(result, options = {}) {
  const file = options.file ?? process.env.DSH_HEALTH_LOG ?? DEFAULT_HEALTH_FILE;
  const stamp = (options.now ?? (() => new Date().toISOString()))();
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${stamp} ${NAME.padEnd(18)} ${result.status.padEnd(4)} ${result.detail}\n`);
    return true;
  } catch {
    return false;
  }
}
