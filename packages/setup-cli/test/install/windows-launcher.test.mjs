import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

async function generatedWindowsShim(root, nodeMajor) {
  const home = path.join(root, `home-${nodeMajor}`);
  const tools = path.join(root, `tools-${nodeMajor}`);
  const nodePath = path.join(tools, "node");
  await mkdir(tools, { recursive: true });
  await writeFile(path.join(tools, "uname"), "#!/usr/bin/env bash\necho MSYS_NT-10.0\n");
  await writeFile(
    path.join(tools, "cygpath"),
    "#!/usr/bin/env bash\nprintf 'C:\\\\repro\\\\%s\\n' \"$(basename \"$2\")\"\n",
  );
  await writeFile(
    nodePath,
    `#!/usr/bin/env bash
case "\${2:-}" in
  *process.versions.node*) echo ${nodeMajor} ;;
  *) exit 1 ;;
esac
`,
  );
  await Promise.all([
    chmod(path.join(tools, "uname"), 0o755),
    chmod(path.join(tools, "cygpath"), 0o755),
    chmod(nodePath, 0o755),
  ]);

  const installSource = await readFile(path.join(REPO_ROOT, "install.sh"), "utf8");
  const runner = path.join(root, `install-functions-${nodeMajor}.sh`);
  await writeFile(
    runner,
    installSource.replace(/\nmain "\$@"\s*$/, '\ninstall_windows_cmd_shim "$1"\n'),
  );
  const result = spawnSync("bash", [runner, nodePath], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${tools}:${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return readFile(path.join(home, ".local/bin/nexus.cmd"), "utf8");
}

describe("Windows installer launcher", () => {
  it("suppresses Node 22 warnings without passing an unsupported flag to Node 18", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fc-windows-launcher-"));
    try {
      const node22 = await generatedWindowsShim(root, 22);
      assert.match(
        node22,
        /"C:\\repro\\node" --disable-warning=ExperimentalWarning "C:\\repro\\nexus\.mjs" %\*/,
      );

      const node18 = await generatedWindowsShim(root, 18);
      assert.match(node18, /"C:\\repro\\node" "C:\\repro\\nexus\.mjs" %\*/);
      assert.doesNotMatch(node18, /--disable-warning/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
