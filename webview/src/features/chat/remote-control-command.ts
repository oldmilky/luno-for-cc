/**
 * Does this message mean "hand this conversation to my other devices"?
 *
 * `/rc` and `/remote-control` are panel commands, not prompts: the CLI does
 * not offer them over stream-json — a headless session does not list them
 * among its slash commands — so anything not caught here reaches the model as
 * literal text.
 *
 * Deliberately strict. The command is the whole message or nothing, matching
 * how the CLI treats slash commands, so a message that merely mentions
 * `/remote-control` while asking about it still gets answered.
 */
export function isRemoteControlCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed === "/rc" || trimmed === "/remote-control";
}
