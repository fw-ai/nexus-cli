import path from "node:path";

const DATA_DIR_RELATIVE = ".nexus/claude-desktop";

export function claudeDesktopDataDir(home) {
  return path.join(home, DATA_DIR_RELATIVE);
}

// Rendered by `on` and `help claude-desktop`; the README table mirrors it verbatim.
export const WORKSPACE_NOTES = [
  "Third-party mode does not show your claude.ai chats, projects, artifacts, memory, or scheduled tasks. Nothing is deleted, and `off` brings them back.",
  "New chats, projects, artifacts, and memory are saved only on this computer. They don't appear on claude.ai web or mobile and can't be shared.",
  "Skills and plugins are copied over on `on`. Run `on` again to copy ones you add later.",
];
