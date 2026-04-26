/**
 * pi-intercom integration helpers.
 *
 * Two responsibilities:
 *   1. Detect whether `pi-intercom` is loaded by looking for its registered
 *      `intercom` tool. We don't take a hard dependency on pi-intercom — a
 *      role can ask for `intercom: send` even when it's not installed; we
 *      just warn and skip injection.
 *   2. Compose a small system-prompt addendum that tells the model how to
 *      use intercom in the requested mode. The addendum is appended to the
 *      role body in `before_agent_start`.
 *
 * Tool inclusion in the active set is handled by `apply.ts` (it adds
 * `intercom` to `setActiveTools` when mode != "off" and the tool exists).
 * This module is purely about the prompt-side addendum.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { IntercomMode } from "./schemas.ts";

/**
 * Name of the tool pi-intercom registers when loaded. Used as the detection
 * marker because it's a stable public identifier.
 */
export const INTERCOM_TOOL_NAME = "intercom";

/**
 * Whether `pi-intercom` is currently loaded. We probe via the registered
 * tool list rather than introspecting the extension registry because
 * `getAllTools()` is the only stable public surface.
 */
export function isIntercomAvailable(pi: ExtensionAPI): boolean {
  return pi.getAllTools().some((t) => t.name === INTERCOM_TOOL_NAME);
}

/**
 * System-prompt addendum for the given mode. Returns an empty string for
 * "off" so the caller can unconditionally concatenate.
 *
 * The addendum is intentionally short — the model already has the tool
 * schema; this just sets behavior expectations per mode. `sessionName` is
 * embedded so the model knows its own targetable identity.
 */
export function intercomPromptAddendum(mode: IntercomMode, sessionName: string | undefined): string {
  if (mode === "off") return "";
  const id = sessionName && sessionName.length > 0 ? sessionName : "(unnamed session)";
  switch (mode) {
    case "receive":
      return [
        "## intercom (receive mode)",
        `This session is targetable as "${id}". Other sessions may send you messages via the \`intercom\` tool. Respond promptly when targeted; do not initiate outbound intercom messages unless the user explicitly asks.`,
      ].join("\n");
    case "send":
      return [
        "## intercom (send mode)",
        `You may send messages to other pi sessions via the \`intercom\` tool when coordination is needed. Identify yourself as "${id}". Use sparingly — only when another session genuinely needs the information.`,
      ].join("\n");
    case "both":
      return [
        "## intercom (both modes)",
        `This session is "${id}". You may send messages to other sessions via the \`intercom\` tool, and you may be targeted by them. Respond promptly when targeted; initiate outbound messages only when coordination is genuinely needed.`,
      ].join("\n");
  }
}
