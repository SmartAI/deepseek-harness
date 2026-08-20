/** Cross-platform native single-directory chooser behind the native backend's capability. */

import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { pickWin32Directory } from './win32-dialog.ts'

/** Testable command boundary; native implementations never invoke a shell. */
export type DirectoryPickerRunner = NativeCommandRunner

/** Injectable platform facts for deterministic adapter tests. */
export interface DirectoryPickerInternals {
  platform?: NodeJS.Platform
  run?: DirectoryPickerRunner
  /** Replaces the in-process Win32 dialog (`pickWin32Directory`) for deterministic tests. */
  pickWin32Dialog?: (signal: AbortSignal) => Promise<string | null>
}

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '')
  return path === '' ? null : path
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function errorStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return ''
  const stderr = (error as { stderr?: unknown }).stderr
  return typeof stderr === 'string' ? stderr : ''
}

function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function rethrowIfAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw error
}

/**
 * Whether a Linux chooser's exit-1 stderr names a display/session failure
 * (no DISPLAY/WAYLAND_DISPLAY reachable, GTK/Qt init aborted) rather than the
 * operator dismissing the dialog. Both zenity (GTK) and kdialog (Qt) print
 * one of these markers to stderr and exit 1 when they cannot open a display;
 * a genuine cancel leaves stderr empty. Matched loosely (case-insensitive,
 * substring) because the exact wording varies across GTK/Qt versions and
 * locales — the alternative (silently mapping this to a cancelled pick) is
 * strictly worse than an occasional false positive here, since the caller
 * still surfaces the real stderr in the thrown error either way.
 */
/**
 * Substrings GTK (zenity) and Qt (kdialog) print to stderr when they cannot
 * reach a display, lowercased for a case-insensitive match. Exact wording
 * varies by GTK/Qt version and locale, so this stays a marker list rather
 * than one strict pattern.
 */
const DISPLAY_FAILURE_MARKERS = [
  'cannot open display',
  'failed to connect to display',
  'failed to connect to socket',
  'no protocol specified',
  'unable to init server',
  'could not connect to display',
  'no such display',
]

function looksLikeDisplayFailure(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return DISPLAY_FAILURE_MARKERS.some(marker => lower.includes(marker))
}

/**
 * Map a Linux chooser's exit-1 failure to a cancelled pick, unless stderr
 * shows the process never reached a display — that case is a broken
 * environment, not an operator decision, and must surface as an error so the
 * UI's error surface (not a silent no-op) tells the operator what happened.
 */
function isLinuxCancellation(error: unknown): boolean {
  return errorCode(error) === 1 && !looksLikeDisplayFailure(errorStderr(error))
}

/**
 * Open the platform directory picker.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - Platform and runner hooks for deterministic tests.
 * @returns the selected path, or null when the user cancels.
 */
export async function pickNativeDirectory(
  signal: AbortSignal,
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    try {
      const result = await run('osascript', [
        '-e', 'set selectedFolder to choose folder with prompt "Select Workspace Directory"',
        '-e', 'POSIX path of selectedFolder',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      if (!signal.aborted && errorCode(error) === 1
        && /(?:User canceled|-128)/i.test(errorStderr(error))) return null
      throw error
    }
  }

  if (platform === 'win32') {
    // The koffi-backed IFileOpenDialog child process — the modern picker with
    // per-monitor-v2 DPI and abort support. koffi is a packaged dependency
    // whose availability the install guarantees, so there is no fallback
    // tier: any failure surfaces as-is (no PowerShell fallback tier; see
    // .agents/notes/implemented/simplification/2026-08-04-drop-windows-powershell-picker-fallback.md).
    const pickDialog = internals.pickWin32Dialog ?? pickWin32Directory
    return await pickDialog(signal)
  }

  if (platform === 'linux') {
    try {
      const result = await run('zenity', [
        '--file-selection', '--directory', '--title=Select Workspace Directory',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (isLinuxCancellation(error)) return null
      if (!isMissingCommand(error)) throw error
    }

    try {
      const result = await run('kdialog', [
        '--getexistingdirectory', '.', '--title', 'Select Workspace Directory',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (isLinuxCancellation(error)) return null
      if (isMissingCommand(error)) {
        throw new Error('no supported native directory picker found (install zenity or kdialog)')
      }
      throw error
    }
  }

  throw new Error(`native directory picker is unsupported on ${platform}`)
}
