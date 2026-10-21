import { defineHarness } from "../../harness/types.mjs";
import { resolveFireworksKeyWithSource } from "../../keys/api-key.mjs";
import { printHarnessConnected, printModelsAdded, printCommandHint, printBody, printNote } from "../../cli/messages.mjs";
import { WORKSPACE_NOTES } from "./core.mjs";

const LABEL = "Claude Desktop";

const adapter = defineHarness({
  id: "claude-desktop",
  label: LABEL,
  async resolveKey(ctx) {
    return (await resolveFireworksKeyWithSource({ home: ctx.home })).key;
  },
  async on(ctx) {
    if (!ctx.home) throw new Error("HOME is not set; pass --home.");
    const { enableProfileLane } = await import("./profile-lane.mjs");
    const result = await enableProfileLane(ctx.home, { model: ctx.main || undefined });
    printHarnessConnected("Claude Desktop");
    printBody("Chat, Cowork, and Code now run on Fireworks models.");
    printModelsAdded(result.models ?? []);
    for (const note of WORKSPACE_NOTES) printNote(note);
    printCommandHint("Quit and reopen Claude Desktop, then", "nexus claude-desktop status");
    printCommandHint("Undo", "nexus claude-desktop off");
  },
  async off(ctx) {
    // Honors ctx.quiet (uninstall narrates itself) and returns the outcome.
    const { disableProfileLane, readProfileState } = await import("./profile-lane.mjs");
    const log = ctx.quiet ? () => {} : (line) => console.log(line);
    const touched = Boolean(await readProfileState(ctx.home));
    if (touched) await disableProfileLane(ctx.home, { log });
    return touched ? "restored" : "none";
  },
  /**
   * nexus claude-desktop mcp [list]
   * nexus claude-desktop mcp add <name> <https-url> [--client-id …] [--client-secret …]
   * nexus claude-desktop mcp remove <name>
   * nexus claude-desktop mcp sync   (re-detect from sessions + the pre-Nexus deployment + the org registry)
   * The applied 3p profile is the source of truth; restart Desktop after changes.
   */
  async mcp(ctx, args = []) {
    const {
      listProfileConnectors, addProfileConnector, removeProfileConnector, syncProfileConnectors,
    } = await import("./profile-lane.mjs");
    const [sub, name, url] = args;

    if (!sub || sub === "list") {
      const connectors = await listProfileConnectors(ctx.home);
      if (!connectors.length) { console.log("No connectors in the profile."); return; }
      for (const c of connectors) console.log(`  ${c.name}  ${c.url ?? c.command ?? ""}`);
      return;
    }

    if (sub === "add") {
      if (!name || !url) throw new Error("Usage: nexus claude-desktop mcp add <name> <https-url> [--client-id <id>] [--client-secret <secret>]");
      await addProfileConnector(ctx.home, {
        name, url,
        ...(ctx.clientId ? { oauth: { clientId: ctx.clientId, ...(ctx.clientSecret ? { clientSecret: ctx.clientSecret } : {}) } } : {}),
      });
      console.log(`Added connector "${name}" to the profile.`);
    } else if (sub === "remove") {
      if (!name) throw new Error("Usage: nexus claude-desktop mcp remove <name>");
      if (!(await removeProfileConnector(ctx.home, name))) {
        console.log(`No connector named "${name}" in the profile.`);
        return;
      }
      console.log(`Removed connector "${name}" from the profile.`);
    } else if (sub === "sync") {
      const { total, fromOrg, registryRead } = await syncProfileConnectors(ctx.home);
      console.log(`Synced ${total} connector(s) into the profile.`);
      console.log(registryRead
        ? `  Included ${fromOrg} from your claude.ai org registry (via the Claude Code CLI).`
        : "  Org registry not read (Claude Code CLI missing or not signed in to claude.ai); used local sources only.");
    } else {
      throw new Error(`Unknown mcp subcommand: ${sub}. Use list | add | remove | sync.`);
    }
    console.log("Restart Claude Desktop to pick up the change.");
  },
  async status(ctx) {
    const { readProfileStatus } = await import("./profile-lane.mjs");
    const profile = await readProfileStatus(ctx.home);
    if (!profile.state) {
      if (ctx.json === true) console.log(JSON.stringify({ enabled: false, lane: null }, null, 2));
      else console.log(`${LABEL}: not configured. Run \`nexus claude-desktop on\`.`);
      return;
    }
    if (ctx.json === true) {
      console.log(JSON.stringify({
        enabled: true, lane: "profile", port: profile.state.port,
        shimHealthy: profile.shimHealthy, profileApplied: profile.appliedProfileIsOurs,
        connectors: profile.state.connectors ?? [],
      }, null, 2));
      return;
    }
    console.log(`${LABEL} profile lane: enabled (Chat/Cowork/Code via shim on 127.0.0.1:${profile.state.port})`);
    console.log(`  Shim: ${profile.shimHealthy ? "healthy" : "NOT RESPONDING"}`);
    console.log(`  Profile applied: ${profile.appliedProfileIsOurs ? "yes" : "no — restart Claude Desktop or check Setup"}`);
    console.log(`  Connectors migrated: ${(profile.state.connectors ?? []).join(", ") || "none detected"}`);
  },
});

export default adapter;
