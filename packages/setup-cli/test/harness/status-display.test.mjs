import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatProvider,
  harnessConnectionFromProvider,
  printStructuredHarnessStatus,
  shortModelId,
} from "../../lib/harness/status-display.mjs";

describe("structured harness status output", () => {
  it("formats real provider boundaries", () => {
    assert.match(formatProvider("fireworks"), /Fireworks/);
    assert.equal(formatProvider("azure"), "Fireworks on Microsoft Foundry");
    assert.equal(formatProvider("default"), "default");
  });

  it("derives connection from real providers only", () => {
    assert.equal(harnessConnectionFromProvider("fireworks"), true);
    assert.equal(harnessConnectionFromProvider("azure"), true);
    assert.equal(harnessConnectionFromProvider("custom"), true);
    assert.equal(harnessConnectionFromProvider("default"), false);
    assert.equal(harnessConnectionFromProvider("none"), false);
  });

  it("shortens canonical model ids", () => {
    assert.equal(shortModelId("accounts/fireworks/routers/firerouter[1m]"), "firerouter");
    assert.equal(shortModelId("accounts/fireworks/models/deepseek-v4-flash"), "deepseek-v4-flash");
    assert.equal(shortModelId("FW-GLM-5.2"), "FW-GLM-5.2");
  });

  it("keeps the firerouter prefix on compound routes", () => {
    assert.equal(shortModelId("firerouter/astra[1m]"), "firerouter/astra");
    assert.equal(shortModelId("firerouter/astra"), "firerouter/astra");
    assert.equal(shortModelId("firerouter"), "firerouter");
  });

  it("prints connection, provider, auth, model, and key source sections", () => {
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printStructuredHarnessStatus("pi", {
        connected: true,
        provider: "fireworks",
        keyConfigured: true,
        authMode: "literal",
        model: "accounts/fireworks/routers/firerouter",
        keySource: "literal key in auth.json",
      });
    } finally {
      console.log = original;
    }
    assert.match(lines.join("\n"), /Pi/);
    assert.match(lines.join("\n"), /Connection: .*on/);
    assert.match(lines.join("\n"), /Provider: .*Fireworks/);
    assert.match(lines.join("\n"), /Model: firerouter/);
    assert.match(lines.join("\n"), /Auth: literal key in auth\.json/);
    assert.doesNotMatch(lines.join("\n"), /Key source/);
  });

  it("shows missing even when a key source is known but the credential is gone", () => {
    // Regression: keySource is a static location label — a routed install whose
    // key was cleared must not present it as authenticated.
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printStructuredHarnessStatus("claude", {
        provider: "fireworks",
        keyConfigured: false,
        authMode: "customHeader",
        keySource: "X-Fireworks-Api-Key header in settings.json",
      });
    } finally {
      console.log = original;
    }
    assert.match(lines.join("\n"), /Auth: missing/);
    assert.doesNotMatch(lines.join("\n"), /X-Fireworks-Api-Key/);
  });

  it("shows missing for literal auth when no key is present", () => {
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printStructuredHarnessStatus("cursor", {
        provider: "none",
        keyConfigured: false,
        authMode: "literal",
      });
    } finally {
      console.log = original;
    }
    assert.match(lines.join("\n"), /Auth: missing/);
  });

  it("shows env-reference wiring even when the key is not currently available", () => {
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printStructuredHarnessStatus("codex", {
        provider: "azure",
        keyConfigured: false,
        authMode: "env-reference",
      });
    } finally {
      console.log = original;
    }
    assert.match(lines.join("\n"), /Auth: environment reference in config/);
  });

  it("shows shell environment when auth mode is missing but a key is available", () => {
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printStructuredHarnessStatus("codex", {
        provider: "fireworks",
        keyConfigured: true,
        authMode: "missing",
      });
    } finally {
      console.log = original;
    }
    assert.match(lines.join("\n"), /Auth: shell environment variable/);
  });

  it("prints model mapping rows with optional pricing detail", () => {
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printStructuredHarnessStatus("claude", {
        connected: true,
        provider: "fireworks",
        keyConfigured: true,
        authMode: "customHeader",
        mappingRows: [
          { slot: "main", value: "glm-5p2-fast", detail: "$1.4 / $4.4" },
        ],
        keySource: "X-Fireworks-Api-Key header in settings.json",
      });
    } finally {
      console.log = original;
    }
    assert.match(lines.join("\n"), /Model mapping:/);
    assert.match(lines.join("\n"), /main\s+-> glm-5p2-fast/);
    assert.match(lines.join("\n"), /\$1\.4 \/ \$4\.4/);
  });

  it("prints no routing line", () => {
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printStructuredHarnessStatus("claude", {
        connected: true,
        provider: "fireworks",
        keyConfigured: true,
        authMode: "customHeader",
      });
    } finally {
      console.log = original;
    }
    assert.doesNotMatch(lines.join("\n"), /Routing:/);
  });
});
