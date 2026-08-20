# Agent Note: Directory-picker backend resolution needs an explicit override for service-managed launches

Status: implemented

English | [中文](2026-08-20-directory-picker-backend-override.zh.md)

## Problem

`resolveDirectoryPickerBackend` infers the operator's location from boot-time process facts: bind host, `SSH_CONNECTION`/`SSH_TTY`, and (on Linux) `DISPLAY`/`WAYLAND_DISPLAY` plus a chooser binary on `PATH`. The package's own README already documents that this inference cannot be proven from launch context alone, and names the specific case of a workstation-local launch later reached through `ssh -L`.

A related, previously undocumented instance of the same gap is a `dsh web` process launched by a service manager — a systemd unit (system-wide or `systemctl --user`), another supervisor. `SSH_CONNECTION`/`SSH_TTY` exist only in an interactive SSH login shell's environment; a service manager never spawns that shell, so a systemd-launched process carries neither marker regardless of how an operator actually reaches it. When such a unit's definition also carries a `DISPLAY` value — baked in at authoring time, inherited from an earlier attach, or simply stale after the referenced X/Wayland session stopped — the resolver's Linux branch sees `DISPLAY` present and no SSH markers, and resolves `native`, even when every real operator reaches the service exclusively through an SSH tunnel and would never see a chooser window that opens on the unattended host. `packages/host/directory-picker-native`'s companion fix ([2026-08-20-linux-directory-picker-display-failure](2026-08-20-linux-directory-picker-display-failure.md)) makes a resulting *chooser failure* surface as a real error instead of a silent no-op, but it cannot fix the case where the chooser succeeds — `zenity`/`kdialog` opening a window on a display no browser operator can see, or the picker's own long-lived, deadline-exempt RPC failing mid-flight over a fragile tunnel.

No boot-time fact closes this gap automatically without a real regression risk: `systemctl --user` services are also common on genuinely attended Linux desktops (autostarted session services), so treating "launched under any systemd unit" as proof of an unattended host would misclassify that legitimate case and silently take away a working native picker from desktop operators who never asked for the change.

## Decision

`resolveDirectoryPickerBackend` reads one new environment variable, `DSH_DIRECTORY_PICKER_BACKEND`, before consulting any inferred signal. When it is set to `native` or `browse` (case-sensitive, exact match), that value is returned outright and no other fact is consulted. Any other value — unset, blank, or unrecognized — falls through to the existing inference chain unchanged; this is boot-time infrastructure, so a typo in the variable must never fail the boot or otherwise misbehave beyond being ignored.

An operator who knows their own topology (a systemd unit reached only through an SSH tunnel, a container, CI, or any other launch context the inference cannot see through) sets this variable once, on the unit or supervisor definition, in place of composing the `-browse` backend and surface packages directly. The existing "compose `-browse` directly" workaround the README documented remains valid and is unaffected; the new variable is a lower-friction way to reach the same outcome without touching the app's plugin composition.

## Alternatives considered

**Detect a service-manager launch automatically (e.g., systemd's `INVOCATION_ID`/`JOURNAL_STREAM`, always present in a unit's spawned-process environment) and force `browse` whenever it is set.** Rejected: a `systemctl --user` service is a normal, common way to autostart a real desktop-session application, and such a process can carry a live, attended `DISPLAY` exactly like an interactively-launched one. Treating "under systemd" as proof of "unattended" would regress that legitimate case for every operator running `dsh web` as a user service on their own desktop — trading one false negative (this bug) for a new false positive with no way for the affected operator to opt back into `native` short of unsetting `DISPLAY`, which the resolver already supports today without this change.

**Spawn a lightweight display probe at boot to confirm the chooser can actually reach a display before choosing `native`.** Rejected: it adds a real subprocess spawn (with the same GTK/Qt startup cost and failure modes as the chooser itself) to every boot, on a resolver the package's own documentation commits to as "one pure decision from sampled host facts." It also cannot close the gap for a display that becomes unreachable *after* boot, since resolution happens once and stays fixed for the service lifetime by design ([2026-08-20-linux-directory-picker-display-failure](2026-08-20-linux-directory-picker-display-failure.md) covers that separate, pick-time failure mode).

**Leave the gap fully undocumented as a known limitation with no operator-facing lever.** Rejected: the package's README already documents the closely related `ssh -L` case and names composing `-browse` directly as the mitigation; leaving the systemd instance of the same gap unaddressed, when a one-line, boot-time, zero-risk override closes it for every operator who can name their own topology, would be a worse outcome than shipping the override.

## Consequences

- An operator who launches `dsh web` from a systemd unit (or any other service manager) reached only through an SSH tunnel can set `DSH_DIRECTORY_PICKER_BACKEND=browse` on that unit and get the working in-app picker permanently, without editing the app's plugin composition or manually unsetting `DISPLAY`.
- The override is bidirectional (`native` is equally supported), so it also serves as an escape hatch for a future inference regression or a deployment the current heuristic misclassifies in the other direction.
- No existing inferred-resolution behavior changes: every prior test case (loopback bind, SSH markers, per-platform display checks, blank-env handling) is unaffected because the override only activates on an explicit, valid value.
- The gap for a *systemd --user service that is also a genuinely attended desktop session* remains unresolved automatically — by design, per the rejected automatic-detection alternative above — and continues to rely on the existing inference chain (which already resolves `native` correctly for that case, since it never reaches this override without an explicit variable).

## Testing

`packages/host/directory-picker-auto/tests/resolve.spec.ts` adds coverage for: the override forcing `browse` on an otherwise fully `native`-eligible configuration; the override forcing `native` even under an all-interfaces bind and an SSH launch, both of which independently resolve to `browse` on their own; the exact systemd-under-an-SSH-tunnel scenario (a loopback-bound, SSH-marker-free, `DISPLAY`-present Linux configuration resolving `native` without the override and `browse` with it); and an unset, blank, or unrecognized override value falling through to unchanged inference. All prior `resolve.spec.ts` cases continue to pass unmodified.
