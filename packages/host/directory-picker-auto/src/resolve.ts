/**
 * Boot-time backend resolution for the adaptive directory-picker composition:
 * one pure decision from sampled host facts to a concrete backend kind. The
 * caller samples exactly once per boot, so the mounted capability stays
 * stable for the service lifetime as the seam requires.
 * @module @deepseek-ai/dsh-host-directory-picker-auto/resolve
 */

import type { Config as HttpServerConfig } from '@deepseek-ai/dsh-host-webserver'

/** Concrete interaction backend the resolver chooses between. */
export type DirectoryPickerBackendKind = 'native' | 'browse'

/** Environment keys the resolution reads (a `process.env` subset). */
export type DirectoryPickerEnv = Readonly<
  Partial<Record<
    'DSH_DIRECTORY_PICKER_BACKEND' | 'SSH_CONNECTION' | 'SSH_TTY' | 'DISPLAY' | 'WAYLAND_DISPLAY', string
  >>
>

/** Every valid `DSH_DIRECTORY_PICKER_BACKEND` override value. */
const DIRECTORY_PICKER_BACKEND_KINDS = ['native', 'browse'] as const

/**
 * Explicit operator override, read from `DSH_DIRECTORY_PICKER_BACKEND`. Every
 * other fact this resolver reads (bind host, SSH launch, display session) is
 * a proxy inferred from the boot-time process environment, and that
 * inference has a real, unclosable gap: a process launched by a service
 * manager (a systemd unit, another supervisor) never carries the launching
 * operator's `SSH_CONNECTION`/`SSH_TTY`, and a `DISPLAY` value baked into
 * its unit file may be stale (a since-stopped session, a revoked
 * `XAUTHORITY`) or, on a systemd --user service, may be a perfectly live
 * desktop session — the two are indistinguishable from process environment
 * alone. Rather than guess, an operator who knows their own topology (a
 * service-managed `dsh web` reached only through an SSH tunnel, a
 * container, CI) sets this variable once, on the unit or supervisor
 * definition, and every inferred signal in {@link resolveDirectoryPickerBackend}
 * is skipped. An unset or unrecognized value returns `undefined` and falls
 * through to inference; this is boot-time infrastructure, so a typo must
 * never fail the boot.
 * @param value - the raw `DSH_DIRECTORY_PICKER_BACKEND` env value.
 * @returns the named backend kind, or `undefined` when absent or invalid.
 */
function explicitBackend(value: string | undefined): DirectoryPickerBackendKind | undefined {
  return (DIRECTORY_PICKER_BACKEND_KINDS as readonly string[]).includes(value ?? '')
    ? value as DirectoryPickerBackendKind
    : undefined
}

/** Host facts the backend choice is a pure function of, sampled once at boot. */
export interface DirectoryPickerHostFacts {
  /** Effective webserver bind host (the schema's closed loopback/all-interfaces union). */
  bindHost: HttpServerConfig['host']
  /** Host process platform. */
  platform: NodeJS.Platform
  /** Environment sample; SSH marks a remote operator, DISPLAY/WAYLAND_DISPLAY a Linux display. */
  env: DirectoryPickerEnv
  /** Whether a Linux chooser binary the native backend can drive (zenity/kdialog) is on PATH; consulted only when `platform` is linux. */
  linuxChooser: boolean
}

/** An env value counts only when set and non-blank (an empty export is "unset" by shell convention). */
const present = (value: string | undefined): boolean => value !== undefined && value !== ''

/**
 * Resolve which backend serves this boot. `DSH_DIRECTORY_PICKER_BACKEND`
 * wins outright when it names a valid kind (see {@link explicitBackend});
 * any other value, including unset, falls through to inference. Absent an
 * override, `native` requires every signal that the operator can see the
 * host display and the native backend can serve it: a loopback-only bind
 * (an all-interfaces bind admits remote browsers no OS chooser can reach),
 * no SSH launch (under SSH port-forwarding the chooser would open on the
 * unattended server), and a servable display session — assumed on
 * darwin/win32, requiring `DISPLAY`/`WAYLAND_DISPLAY` plus a chooser binary
 * on linux, and never true elsewhere (the native backend drives exactly
 * darwin/win32/linux). Anything ambiguous resolves to `browse`, which works
 * everywhere.
 * @param facts - the sampled host facts.
 * @returns the backend kind to mount.
 */
export function resolveDirectoryPickerBackend(facts: DirectoryPickerHostFacts): DirectoryPickerBackendKind {
  const override = explicitBackend(facts.env.DSH_DIRECTORY_PICKER_BACKEND)
  if (override !== undefined) return override
  if (facts.bindHost !== '127.0.0.1') return 'browse'
  if (present(facts.env.SSH_CONNECTION) || present(facts.env.SSH_TTY)) return 'browse'
  if (facts.platform === 'darwin' || facts.platform === 'win32') return 'native'
  if (facts.platform !== 'linux' || !facts.linuxChooser) return 'browse'
  return present(facts.env.DISPLAY) || present(facts.env.WAYLAND_DISPLAY) ? 'native' : 'browse'
}
