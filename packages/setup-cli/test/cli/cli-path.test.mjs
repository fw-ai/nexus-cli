import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  keyExportCommand,
  resolveCliPath,
} from "../../lib/cli/path.mjs";
import { withTempHome } from "../helpers.mjs";

describe("cli-path", () => {
  it("follows npm-global launcher symlink to nexus.mjs for apiKeyHelper", async () => {
    await withTempHome("cli-path-symlink", async (home) => {
      const binDir = path.join(home, ".local/bin");
      const pkgDir = path.join(home, "pkg");
      const entry = path.join(pkgDir, "nexus.mjs");
      await mkdir(binDir, { recursive: true });
      await mkdir(pkgDir, { recursive: true });
      await writeFile(entry, "#!/usr/bin/env node\n", "utf8");
      await chmod(entry, 0o755);
      await symlink(entry, path.join(binDir, "nexus"));

      const resolved = resolveCliPath(home);
      // resolveCliPath follows symlinks via realpathSync, which
      // canonicalizes (e.g. macOS /var → /private/var) — compare canonically.
      assert.equal(resolved, realpathSync(entry));

      const cmd = keyExportCommand(home);
      assert.match(cmd, new RegExp(`^${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
      assert.match(cmd, /--home /);
      assert.match(cmd, /nexus\.mjs --home .+ key export --stored-only$/);
    });
  });

  it("uses install.sh bash launcher without a node prefix", async () => {
    await withTempHome("cli-path-bash", async (home) => {
      const binDir = path.join(home, ".local/bin");
      const launcher = path.join(binDir, "nexus");
      await mkdir(binDir, { recursive: true });
      await writeFile(
        launcher,
        "#!/usr/bin/env bash\nexec /usr/bin/node /opt/nexus.mjs \"$@\"\n",
        "utf8",
      );
      await chmod(launcher, 0o755);

      const cmd = keyExportCommand(home);
      // The launcher path is canonicalized via realpathSync (macOS /var → /private/var).
      assert.equal(cmd, `${realpathSync(launcher)} --home ${home} key export --stored-only`);
    });
  });
});
