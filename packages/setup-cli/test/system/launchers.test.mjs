import assert from "node:assert/strict";
import { access, lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { migrateLegacyLaunchers, ownedLaunchers } from "../../lib/system/launchers.mjs";
import { withTempHome } from "../helpers.mjs";

async function writeBin(home, name, content) {
  const bin = path.join(home, ".local/bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, name), content);
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

async function installNexus(home) {
  const bin = path.join(home, ".nexus/cli/packages/setup-cli/bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "nexus.mjs"), "");
}

const legacyLauncher = (home) => `#!/usr/bin/env bash\nexec node "${home}/.fireconnect/cli/packages/setup-cli/bin/fireconnect.mjs" "$@"\n`;

describe("migrateLegacyLaunchers", () => {
  it("replaces fireconnect with a nexus launcher pointing at ~/.nexus", async () => {
    await withTempHome("launchers-replace-", async (home) => {
      await installNexus(home);
      await writeBin(home, "fireconnect", legacyLauncher(home));

      const notes = await migrateLegacyLaunchers(home);
      assert.deepEqual(notes, ["Replaced the `fireconnect` command with `nexus`."]);
      assert.equal(
        await readFile(path.join(home, ".local/bin/nexus"), "utf8"),
        `#!/usr/bin/env bash\nexec node "${home}/.nexus/cli/packages/setup-cli/bin/nexus.mjs" "$@"\n`,
      );
      assert.equal(await exists(path.join(home, ".local/bin/fireconnect")), false);
      assert.deepEqual(await migrateLegacyLaunchers(home), [], "idempotent");
    });
  });

  it("keeps an installer-written nexus launcher and removes the legacy one", async () => {
    await withTempHome("launchers-existing-", async (home) => {
      const fresh = `exec node "${home}/.nexus/cli/packages/setup-cli/bin/nexus.mjs" "$@"\n`;
      await writeBin(home, "nexus", fresh);
      await writeBin(home, "fireconnect", legacyLauncher(home));

      await migrateLegacyLaunchers(home);
      assert.equal(await readFile(path.join(home, ".local/bin/nexus"), "utf8"), fresh);
      assert.equal(await exists(path.join(home, ".local/bin/fireconnect")), false);
    });
  });

  it("leaves another program's nexus alone and keeps the fireconnect command", async () => {
    await withTempHome("launchers-foreign-", async (home) => {
      await installNexus(home);
      const foreign = "#!/bin/sh\nexec other-tool \"$@\"\n";
      await writeBin(home, "nexus", foreign);
      await writeBin(home, "fireconnect", legacyLauncher(home));

      const notes = await migrateLegacyLaunchers(home);

      assert.equal(notes.length, 1);
      assert.match(notes[0], /~\/\.local\/bin\/nexus belongs to another program, so the `fireconnect` command stays/);
      assert.equal(await readFile(path.join(home, ".local/bin/nexus"), "utf8"), foreign);
      assert.equal(await exists(path.join(home, ".local/bin/fireconnect")), true);
      assert.deepEqual((await readdir(path.join(home, ".local/bin"))).sort(), ["fireconnect", "nexus"]);
    });
  });

  it("never writes through a symlinked nexus that isn't ours", async () => {
    await withTempHome("launchers-foreign-link-", async (home) => {
      await installNexus(home);
      const other = path.join(home, "other-tool");
      await writeFile(other, "#!/bin/sh\necho other\n");
      await mkdir(path.join(home, ".local/bin"), { recursive: true });
      await symlink(other, path.join(home, ".local/bin/nexus"));
      await writeBin(home, "fireconnect", legacyLauncher(home));

      await migrateLegacyLaunchers(home);
      assert.equal(await readFile(other, "utf8"), "#!/bin/sh\necho other\n");
      assert.equal(await readlink(path.join(home, ".local/bin/nexus")), other);
    });
  });

  it("keeps pointing at ~/.fireconnect until the new install exists there", async () => {
    await withTempHome("launchers-not-yet-", async (home) => {
      await writeBin(home, "fireconnect", legacyLauncher(home));

      await migrateLegacyLaunchers(home);
      assert.equal(
        await readFile(path.join(home, ".local/bin/nexus"), "utf8"),
        `#!/usr/bin/env bash\nexec node "${home}/.fireconnect/cli/packages/setup-cli/bin/nexus.mjs" "$@"\n`,
      );
    });
  });

  it("migrates the Windows cmd shim", async () => {
    await withTempHome("launchers-cmd-", async (home) => {
      await installNexus(home);
      await writeBin(home, "fireconnect.cmd", "@echo off\r\n\"C:\\node.exe\" \"C:\\Users\\dev\\.fireconnect\\cli\\packages\\setup-cli\\bin\\fireconnect.mjs\" %*\r\n");

      await migrateLegacyLaunchers(home);
      assert.equal(
        await readFile(path.join(home, ".local/bin/nexus.cmd"), "utf8"),
        "@echo off\r\n\"C:\\node.exe\" \"C:\\Users\\dev\\.nexus\\cli\\packages\\setup-cli\\bin\\nexus.mjs\" %*\r\n",
      );
      assert.equal(await exists(path.join(home, ".local/bin/fireconnect.cmd")), false);
    });
  });

  it("does nothing without a legacy launcher, and never touches foreign ones", async () => {
    await withTempHome("launchers-none-", async (home) => {
      assert.deepEqual(await migrateLegacyLaunchers(home), []);
      await writeBin(home, "fireconnect", "#!/bin/sh\necho someone else\n");
      assert.deepEqual(await migrateLegacyLaunchers(home), []);
      assert.equal(await exists(path.join(home, ".local/bin/fireconnect")), true);
      assert.deepEqual(await ownedLaunchers(home), []);
    });
  });
});
