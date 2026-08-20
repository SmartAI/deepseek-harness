# Agent Note: Linux native directory picker must not swallow display failures as cancellation

Status: implemented

English | [中文](2026-08-20-linux-directory-picker-display-failure.zh.md)

## Problem

`resolveDirectoryPickerBackend` mounts the `native` directory-picker backend on Linux only when it samples `DISPLAY`/`WAYLAND_DISPLAY` as present at boot — a reasonable proxy for "this process can reach a display" at that moment. That proxy can go stale: a process managed by an init system (systemd, a supervisor) may carry a `DISPLAY` value from its unit definition or an earlier attach without ever holding a live, authorized connection to that display (a stopped X/Wayland session, a missing or wrong `XAUTHORITY`, a denied socket). The boot-time check has no way to observe this, because it never spawns the chooser — it only inspects environment variables.

At pick time, `pickNativeDirectory`'s Linux branch ran `zenity` (falling back to `kdialog` only on `ENOENT`) and mapped every exit-code-1 failure to a cancelled pick (`return null`), with no distinction between "the operator dismissed the dialog" and "the chooser process never managed to open a window." GTK (zenity) and Qt (kdialog) both exit 1 and print a display-connection diagnostic to stderr when they cannot reach a display; that diagnostic was discarded, and the operator-facing outcome was indistinguishable from clicking Cancel. `NativeDirectoryFlow` (the client occupant) drives a `null` result into `onCancel()`, a silent no-op, and any thrown error into `onError(message)`, a visible error surface — so this misclassification means clicking "Add workspace" produced no dialog and no feedback at all.

## Decision

`pickNativeDirectory`'s Linux branch keeps treating exit code 1 as cancellation by default (this remains the correct and only reliable signal for a real Cancel click, which leaves stderr empty), but first checks the failure's stderr for known GTK/Qt display-connection markers (`looksLikeDisplayFailure`, matched against a marker list — "cannot open display", "failed to connect to display", "failed to connect to socket", "no protocol specified", "unable to init server", "could not connect to display", "no such display"). When one matches, the failure is not treated as a cancellation and is rethrown as-is (with its captured stdout/stderr/cause), reaching `onError` and giving the operator a real diagnostic instead of a picker that appears to do nothing. This mirrors the existing macOS branch, which already distinguishes a genuine `osascript` "User canceled. (-128)" cancellation from any other exit-1 failure by inspecting stderr rather than trusting the exit code alone.

The zenity→kdialog fallback tier is unaffected: it still triggers only on `ENOENT` (the tool is missing), never on a display failure, so a zenity display failure surfaces immediately rather than silently retrying with kdialog (which would fail identically in the same broken environment).

## Alternatives considered

**Tighten the boot-time `resolveDirectoryPickerBackend` probe to spawn a real chooser and confirm a live display before choosing `native`.** Rejected: it would add a real subprocess spawn (with the same GTK/Qt startup cost and failure modes being diagnosed) to every boot, on a resolver documented as "one pure decision from sampled host facts," and does not close the gap for a display that dies *after* boot — the resolution is sampled once and stays fixed for the service lifetime by design.

**Match an exact stderr string per chooser (mirroring macOS's single-phrase check) instead of a marker list.** Rejected: unlike `osascript`'s stable, documented "User canceled. (-128)" message, GTK/Qt display-connection diagnostics vary by toolkit version, backend (X11 vs Wayland), and locale; a marker list tolerates that variance without chasing every wording.

**Leave the failure mapped to cancellation and instead fix the environment (document that operators must propagate `DISPLAY`/`WAYLAND_DISPLAY`/`XAUTHORITY` into service-managed `dsh web` processes).** Rejected as the complete fix: that guidance is real and worth documenting, but it addresses only the well-configured case. A misconfigured, stale, or since-revoked display session is a reachable state this code must degrade out of loudly, not silently — that's what the client's `onError` surface exists for.

## Consequences

- A Linux `native` picker whose `DISPLAY`/`WAYLAND_DISPLAY` was live at boot but unreachable at pick time now surfaces a real, informative error to the operator instead of behaving as a silently no-op "Add workspace" button.
- A genuine Cancel click (empty stderr, exit 1) is unaffected and still resolves to `null`.
- The zenity→kdialog fallback stays scoped to `ENOENT` only; a display failure on either tool surfaces immediately without a masked retry.
- The marker list is a heuristic over stderr text, not an exhaustive enumeration of every GTK/Qt build's exact wording; an unmatched future diagnostic would still (as before this change) fall through to cancellation. This is a known, bounded gap — expanding the marker list is a safe, local follow-up, not a design change.

## Testing

`packages/host/directory-picker-native/tests/native-picker.spec.ts` adds coverage for: zenity and kdialog exit-1 failures whose stderr names a display/session failure (single- and multi-line stderr) surfacing as errors rather than `null`; a zenity display failure not falling back to kdialog (only `ENOENT` falls back); and a kdialog display failure surfacing after a zenity `ENOENT`. The existing genuine-cancellation coverage (empty-stderr exit 1 for both zenity and kdialog, including the zenity→kdialog `ENOENT` fallback path) is unchanged and still passes.
