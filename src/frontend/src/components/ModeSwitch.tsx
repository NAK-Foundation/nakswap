/**
 * The app is sandbox-only: there is no Live mode and no mode switch.
 * This module is intentionally inert and retained only so stale imports do not
 * break the build. New code must not depend on it.
 */
export function ModeSwitch() {
  return null;
}
