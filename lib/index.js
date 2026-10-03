/**
 * Host half intentionally has no persistence or session inspection.
 *
 * The first version is client-local by design:
 * - one DSH conversation at a time;
 * - no cross-session or external-memory reads;
 * - only a timestamp and a short copy of the current conversation's last
 *   rendered message are stored in the browser profile.
 *
 * Keeping this host half inert means installing the prototype cannot alter
 * DSH's session log, agent instructions, or prompt admission pipeline.
 */
export const name = "dsh-welcome-back";

export function apply() {
  // The browser client owns this deliberately narrow first version.
}
