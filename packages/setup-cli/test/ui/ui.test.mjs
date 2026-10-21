import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { BRAND, isColorEnabled, loadBannerArt, printBanner } from "../../lib/ui/index.mjs";
import { stripBannerMarkup } from "../../lib/ui/banner-render.mjs";
import { callbackPage } from "../../lib/auth/browser-auth.mjs";
import {
  _setColorEnabled,
  accent,
  closestMatch,
  colorizeHelp,
  colorsEnabled,
  dim,
  fail,
  muted,
  ok,
  warn,
  withSuggestion,
  yesNo,
} from "../../lib/ui.mjs";
import { runFireconnect } from "../helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNER_SCRIPT = path.join(__dirname, "../../bin/nexus-banner.mjs");

function runBannerScript(args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BANNER_SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("ui tokens", () => {
  it("exports official brand purple", () => {
    assert.equal(BRAND.purple, "#6720FF");
    assert.equal(BRAND.glow, "#A87FFF");
    assert.equal(BRAND.deep, "#501CBE");
  });

  it("uses brand purple in OAuth callback SVG", () => {
    assert.match(callbackPage(true), new RegExp(`fill:${BRAND.purple}`));
  });
});

describe("ui color", () => {
  it("disables color when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      assert.equal(isColorEnabled({ isTTY: true }), false);
    } finally {
      if (prev === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prev;
      }
    }
  });

  it("enables color when FORCE_COLOR is set on a non-tty stream", () => {
    const prevNo = process.env.NO_COLOR;
    const prevForce = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      assert.equal(isColorEnabled({ isTTY: false }), true);
    } finally {
      if (prevNo === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prevNo;
      }
      if (prevForce === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = prevForce;
      }
    }
  });

  it("disables color on non-tty streams by default", () => {
    const prevNo = process.env.NO_COLOR;
    const prevForce = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    try {
      assert.equal(isColorEnabled({ isTTY: false }), false);
    } finally {
      if (prevNo === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prevNo;
      }
      if (prevForce === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = prevForce;
      }
    }
  });
});

describe("colorsEnabled", () => {
  it("is off for non-TTY streams", () => {
    assert.equal(colorsEnabled({ isTTY: false }, {}), false);
  });

  it("is on for TTY streams", () => {
    assert.equal(colorsEnabled({ isTTY: true }, {}), true);
  });

  it("NO_COLOR wins over TTY", () => {
    assert.equal(colorsEnabled({ isTTY: true }, { NO_COLOR: "1" }), false);
  });

  it("FORCE_COLOR wins over non-TTY", () => {
    assert.equal(colorsEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  });

  it("FORCE_COLOR=0 does not force", () => {
    assert.equal(colorsEnabled({ isTTY: false }, { FORCE_COLOR: "0" }), false);
  });

  it("TERM=dumb disables color", () => {
    assert.equal(colorsEnabled({ isTTY: true }, { TERM: "dumb" }), false);
  });
});

describe("styling", () => {
  afterEach(() => {
    _setColorEnabled(false);
  });

  it("emits no escape codes when disabled (test/pipe default)", () => {
    _setColorEnabled(false);
    assert.equal(dim("plain"), "plain");
    assert.ok(!ok("done").includes("\x1b"));
    assert.ok(!fail("broke").includes("\x1b"));
    assert.ok(!warn("careful").includes("\x1b"));
    assert.ok(!yesNo(true).includes("\x1b"));
    const help = "Commands:\n  on    Enable";
    assert.equal(colorizeHelp(help), help);
  });

  it("emits escape codes when enabled", () => {
    _setColorEnabled(true);
    assert.ok(dim("x").includes("\x1b[2m"));
    assert.ok(yesNo(true).includes("\x1b[36m"));
    assert.ok(yesNo(false).includes("\x1b[31m"));
  });

  it("accent uses cyan when enabled", () => {
    _setColorEnabled(true);
    assert.ok(accent("cmd").includes("\x1b[36m"));
  });

  it("accent stays plain on a non-TTY stream", () => {
    _setColorEnabled(false);
    assert.equal(accent("cmd", { isTTY: false }), "cmd");
  });

  it("muted uses 90m gray when enabled", () => {
    _setColorEnabled(true);
    assert.ok(muted("label").includes("\x1b[90m"));
  });

  it("colorizeHelp bolds section headers and keeps layout", () => {
    _setColorEnabled(true);
    const colored = colorizeHelp("Commands:\n  on    Enable routing");
    const lines = colored.split("\n");
    assert.ok(lines[0].startsWith("\x1b[1m"));
    // Indentation is untouched so columns still line up.
    assert.ok(lines[1].replace(/\x1b\[[0-9;]*m/g, "") === "  on    Enable routing");
  });

  it("colorizeHelp uses bold for command tokens, never cyan", () => {
    _setColorEnabled(true);
    const colored = colorizeHelp("Commands:\n  on    Enable routing\n  --api-key <key>  Key");
    assert.ok(colored.includes("\x1b[1mon\x1b[22m"));
    assert.ok(colored.includes("\x1b[1m--api-key\x1b[22m"));
    assert.ok(!colored.includes("\x1b[36m"));
  });
});

describe("closestMatch", () => {
  it("finds a near miss", () => {
    assert.equal(closestMatch("cluade", ["claude", "opencode", "codex"]), "claude");
    assert.equal(closestMatch("statsu", ["on", "off", "status"]), "status");
    assert.equal(closestMatch("--serach", ["--search", "--model", "--mode"]), "--search");
  });

  it("returns nothing when everything is far away", () => {
    assert.equal(closestMatch("zzzzzz", ["claude", "opencode"]), "");
    assert.equal(closestMatch("--slot", ["--json", "--model", "--search"]), "");
  });

  it("withSuggestion appends only when a match exists", () => {
    assert.equal(
      withSuggestion("Unknown command: cluade.", "cluade", ["claude"]),
      "Unknown command: cluade. Did you mean: claude?",
    );
    assert.equal(
      withSuggestion("Unknown command: zzzzzz.", "zzzzzz", ["claude"]),
      "Unknown command: zzzzzz.",
    );
  });
});

describe("ui banner", () => {
  it("loads checked-in banner art within 80 columns", () => {
    const art = loadBannerArt();
    assert.ok(art.length > 0);
    for (const line of art.split("\n")) {
      const width = stripBannerMarkup(line).length;
      assert.ok(width <= 80, `line exceeds 80 cols: ${width}`);
    }
  });

  it("includes the Ignite your Harness tagline", () => {
    const art = loadBannerArt();
    assert.match(stripBannerMarkup(art), /Ignite your Harness/);
  });

  it("prints plain banner art without ANSI when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    const chunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      printBanner();
      const output = chunks.join("");
      assert.match(output, /Nexus/);
      assert.match(output, /Ignite your Harness/);
      assert.doesNotMatch(output, /\x1b\[/);
    } finally {
      process.stdout.write = originalWrite;
      if (prev === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prev;
      }
    }
  });
});

describe("fireconnect banner command", () => {
  it("prints banner art (hidden command, not in help)", async () => {
    const { code, stdout } = await runFireconnect(["banner"], { NO_COLOR: "1" });
    assert.equal(code, 0);
    assert.match(stdout, /Nexus/);
    assert.match(stdout, /Ignite your Harness/);
  });

  it("is not listed in fireconnect help", async () => {
    const { code, stdout } = await runFireconnect(["help"], { NO_COLOR: "1" });
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /\bbanner\b/);
  });
});

describe("fireconnect-banner internal script", () => {
  it("prints install success context without art when --success-only", async () => {
    const { code, stdout } = await runBannerScript(["--context", "install", "--success-only"], { NO_COLOR: "1" });
    assert.equal(code, 0);
    assert.match(stdout, /Nexus is installed\./);
    assert.doesNotMatch(stdout, /Ignite your Harness/);
  });

  it("prints banner art and install success for the installer finish screen", async () => {
    const { code, stdout } = await runBannerScript(["--context", "install"], { NO_COLOR: "1" });
    assert.equal(code, 0);
    assert.match(stdout, /Ignite your Harness/);
    assert.match(stdout, /Nexus is installed\./);
  });
});
