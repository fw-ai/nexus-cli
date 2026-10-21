import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  claimSessionPriceHealing,
  hasUnpricedModels,
  refreshPriceCaches,
  sessionIdFromTranscript,
  spawnPriceRefresh,
  waitForPricedUsage,
} from "../../../lib/harnesses/claude/statusline-refresh.mjs";

function withTempHome(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "fc-statusline-refresh-test-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const done = () => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  };
  let result;
  try {
    result = fn(home);
  } catch (error) {
    done();
    throw error;
  }
  if (result?.then) {
    return result.then(
      (value) => {
        done();
        return value;
      },
      (error) => {
        done();
        throw error;
      },
    );
  }
  done();
  return result;
}

function markerFile(home, sessionId) {
  return path.join(home, ".nexus", "statusline-refresh", `${sessionId}.refreshed`);
}

function pricedUsage() {
  return { models: [{ label: "Ember-1", cost: 0.03 }] };
}

function unpricedUsage() {
  return { models: [{ label: "Ember-1", cost: 0.03 }, { label: "Mystery", cost: null }] };
}

describe("sessionIdFromTranscript", () => {
  it("takes the basename without .jsonl", () => {
    assert.equal(sessionIdFromTranscript("/a/.claude/projects/x/abc123.jsonl"), "abc123");
  });

  it("rejects empty, non-jsonl, and bare-extension paths", () => {
    assert.equal(sessionIdFromTranscript(""), "");
    assert.equal(sessionIdFromTranscript(null), "");
    assert.equal(sessionIdFromTranscript("/a/session.txt"), "");
    assert.equal(sessionIdFromTranscript(".jsonl"), "");
  });
});

describe("hasUnpricedModels", () => {
  it("is false without models and true with a null cost", () => {
    assert.equal(hasUnpricedModels(null), false);
    assert.equal(hasUnpricedModels({ models: [] }), false);
    assert.equal(hasUnpricedModels(pricedUsage()), false);
    assert.equal(hasUnpricedModels(unpricedUsage()), true);
  });
});

describe("claimSessionPriceHealing", () => {
  it("claims once per session", () => {
    withTempHome((home) => {
      const opts = { home, transcriptPath: "/t/sess-1.jsonl", usage: unpricedUsage() };
      // NEXUS_TEST is "1" globally; these pure-marker cases opt out.
      const prev = process.env.NEXUS_TEST;
      delete process.env.NEXUS_TEST;
      try {
        assert.equal(claimSessionPriceHealing(opts), true);
        assert.ok(existsSync(markerFile(home, "sess-1")));
        assert.equal(claimSessionPriceHealing(opts), false);
        assert.equal(
          claimSessionPriceHealing({ ...opts, transcriptPath: "/t/sess-2.jsonl" }),
          true,
        );
      } finally {
        if (prev === undefined) {
          delete process.env.NEXUS_TEST;
        } else {
          process.env.NEXUS_TEST = prev;
        }
      }
    });
  });

  it("declines priced usage, gates, and missing inputs without touching disk", () => {
    withTempHome((home) => {
      const usage = unpricedUsage();
      // Test gate holds (set globally): no marker dir created.
      assert.equal(claimSessionPriceHealing({ home, transcriptPath: "/t/s.jsonl", usage }), false);
      assert.equal(existsSync(path.join(home, ".nexus")), false);
      assert.equal(claimSessionPriceHealing({ home, transcriptPath: "/t/s.jsonl", usage: pricedUsage() }), false);
      assert.equal(claimSessionPriceHealing({ home: "", transcriptPath: "/t/s.jsonl", usage }), false);
      assert.equal(claimSessionPriceHealing({ home, transcriptPath: "", usage }), false);
      assert.equal(claimSessionPriceHealing({ home, transcriptPath: "/t/s.jsonl", usage: null }), false);
      process.env.NEXUS_STATUSLINE_REFRESH = "0";
      try {
        assert.equal(claimSessionPriceHealing({ home, transcriptPath: "/t/s.jsonl", usage }), false);
      } finally {
        delete process.env.NEXUS_STATUSLINE_REFRESH;
      }
    });
  });

  it("prunes markers older than a week", () => {
    withTempHome((home) => {
      const prev = process.env.NEXUS_TEST;
      delete process.env.NEXUS_TEST;
      try {
        const dir = path.join(home, ".nexus", "statusline-refresh");
        mkdirSync(dir, { recursive: true });
        const stale = path.join(dir, "old.refreshed");
        writeFileSync(stale, "1");
        const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        utimesSync(stale, weekAgo, weekAgo);
        assert.equal(
          claimSessionPriceHealing({ home, transcriptPath: "/t/new.jsonl", usage: unpricedUsage() }),
          true,
        );
        assert.equal(existsSync(stale), false);
        assert.ok(existsSync(markerFile(home, "new")));
      } finally {
        if (prev === undefined) {
          delete process.env.NEXUS_TEST;
        } else {
          process.env.NEXUS_TEST = prev;
        }
      }
    });
  });

  it("claims again when a new unpriced model joins the session", () => {
    withTempHome((home) => {
      const prev = process.env.NEXUS_TEST;
      delete process.env.NEXUS_TEST;
      try {
        const transcriptPath = "/t/switch.jsonl";
        const first = { models: [{ id: "mystery-a", label: "Mystery A", cost: null }] };
        const second = {
          models: [
            { id: "mystery-a", label: "Mystery A", cost: null },
            { id: "mystery-b", label: "Mystery B", cost: null },
          ],
        };
        assert.equal(claimSessionPriceHealing({ home, transcriptPath, usage: first }), true);
        assert.equal(claimSessionPriceHealing({ home, transcriptPath, usage: first }), false);
        assert.equal(claimSessionPriceHealing({ home, transcriptPath, usage: second }), true);
        assert.equal(claimSessionPriceHealing({ home, transcriptPath, usage: second }), false);
      } finally {
        if (prev === undefined) {
          delete process.env.NEXUS_TEST;
        } else {
          process.env.NEXUS_TEST = prev;
        }
      }
    });
  });

  it("grants a session with a legacy timestamp marker one more attempt", () => {
    withTempHome((home) => {
      const prev = process.env.NEXUS_TEST;
      delete process.env.NEXUS_TEST;
      try {
        const dir = path.join(home, ".nexus", "statusline-refresh");
        mkdirSync(dir, { recursive: true });
        writeFileSync(markerFile(home, "legacy"), String(Date.now()));
        const opts = { home, transcriptPath: "/t/legacy.jsonl", usage: unpricedUsage() };
        assert.equal(claimSessionPriceHealing(opts), true);
        assert.equal(claimSessionPriceHealing(opts), false);
      } finally {
        if (prev === undefined) {
          delete process.env.NEXUS_TEST;
        } else {
          process.env.NEXUS_TEST = prev;
        }
      }
    });
  });
});

describe("refreshPriceCaches", () => {
  it("resolves nothing and touches nothing without a key", async () => {
    await withTempHome(async (home) => {
      // Drop the developer's real env key so resolution finds nothing stored.
      const prevKey = process.env.FIREWORKS_API_KEY;
      delete process.env.FIREWORKS_API_KEY;
      try {
        await refreshPriceCaches({ home });
        await refreshPriceCaches({});
        assert.deepEqual(readdirSync(home), []);
      } finally {
        if (prevKey === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prevKey;
        }
      }
    });
  });

  it("falls back to the key in Claude Code's gateway header", async () => {
    await withTempHome(async (home) => {
      const seen = [];
      const server = createServer((req, res) => {
        seen.push(req.headers.authorization ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const prevKey = process.env.FIREWORKS_API_KEY;
      const prevGateway = process.env.NEXUS_GATEWAY_URL;
      delete process.env.FIREWORKS_API_KEY;
      process.env.NEXUS_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
      try {
        await refreshPriceCaches({
          home,
          env: { ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_header_key" },
        });
        assert.deepEqual(seen, ["Bearer fw_test_header_key"]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        for (const [name, value] of [["FIREWORKS_API_KEY", prevKey], ["NEXUS_GATEWAY_URL", prevGateway]]) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }
    });
  });
});

describe("spawnPriceRefresh", () => {
  it("spawns the detached runner once, releasing the marker on failure", () => {
    withTempHome((home) => {
      const prev = process.env.NEXUS_TEST;
      delete process.env.NEXUS_TEST;
      try {
        const spawns = [];
        const listeners = {};
        const child = {
          unrefCalled: false,
          exitCode: null,
          unref() {
            this.unrefCalled = true;
          },
          on(event, fn) {
            listeners[event] = fn;
            return this;
          },
        };
        const got = spawnPriceRefresh({
          home,
          sessionId: "sess-1",
          spawnFn: (...args) => {
            spawns.push(args);
            return child;
          },
        });
        assert.equal(got, child);
        assert.equal(spawns.length, 1);
        const [cmd, argv, opts] = spawns[0];
        assert.equal(cmd, process.execPath);
        assert.ok(argv[0].endsWith("bin/claude-price-refresh.mjs"));
        assert.equal(opts.detached, true);
        assert.equal(opts.stdio, "ignore");
        assert.equal(opts.windowsHide, true);
        assert.equal(child.unrefCalled, true);
        // An async spawn death releases the marker so the next turn retries.
        mkdirSync(path.join(home, ".nexus", "statusline-refresh"), { recursive: true });
        writeFileSync(markerFile(home, "sess-1"), "1");
        listeners.error(new Error("ENOENT"));
        assert.equal(existsSync(markerFile(home, "sess-1")), false);
      } finally {
        if (prev === undefined) {
          delete process.env.NEXUS_TEST;
        } else {
          process.env.NEXUS_TEST = prev;
        }
      }
    });
  });

  it("returns null without claiming when spawning is impossible", () => {
    withTempHome((home) => {
      const prev = process.env.NEXUS_TEST;
      delete process.env.NEXUS_TEST;
      try {
        mkdirSync(path.join(home, ".nexus", "statusline-refresh"), { recursive: true });
        writeFileSync(markerFile(home, "sess-9"), "1");
        assert.equal(
          spawnPriceRefresh({
            home,
            sessionId: "sess-9",
            spawnFn: () => {
              throw new Error("no proc");
            },
          }),
          null,
        );
        assert.equal(existsSync(markerFile(home, "sess-9")), false);
        assert.equal(spawnPriceRefresh({ home: "", sessionId: "s" }), null);
      } finally {
        if (prev === undefined) {
          delete process.env.NEXUS_TEST;
        } else {
          process.env.NEXUS_TEST = prev;
        }
      }
    });
  });
});

describe("waitForPricedUsage", () => {
  const priced = { models: [{ label: "Ember-1", cost: 0.03 }] };
  const unpriced = { models: [{ label: "Mystery", cost: null }] };

  it("returns the first priced read, reloading caches every tick", async () => {
    let reads = 0;
    let reloads = 0;
    const usage = await waitForPricedUsage({
      readUsage: async () => {
        reads += 1;
        return reads < 3 ? unpriced : priced;
      },
      reloadCaches: () => {
        reloads += 1;
      },
      child: { exitCode: null },
      timeoutMs: 1000,
      intervalMs: 1,
    });
    assert.deepEqual(usage, priced);
    assert.equal(reads, 3);
    assert.equal(reloads, 3);
  });

  it("stops early when the runner exits and stays bounded otherwise", async () => {
    let reads = 0;
    const exited = await waitForPricedUsage({
      readUsage: async () => {
        reads += 1;
        return unpriced;
      },
      child: { exitCode: 1 },
      timeoutMs: 1000,
      intervalMs: 1,
    });
    assert.deepEqual(exited, unpriced);
    assert.ok(reads <= 2);
    const started = Date.now();
    const timedOut = await waitForPricedUsage({
      readUsage: async () => unpriced,
      child: { exitCode: null },
      timeoutMs: 40,
      intervalMs: 5,
    });
    assert.deepEqual(timedOut, unpriced);
    assert.ok(Date.now() - started < 2000);
  });

  it("surfaces the last usage when reads fail", async () => {
    assert.equal(
      await waitForPricedUsage({
        readUsage: async () => null,
        child: { exitCode: null },
        timeoutMs: 40,
        intervalMs: 5,
      }),
      null,
    );
    assert.equal(
      await waitForPricedUsage({
        readUsage: async () => {
          throw new Error("unreadable");
        },
        child: { exitCode: null },
        timeoutMs: 40,
        intervalMs: 5,
      }),
      null,
    );
  });

  it("never mistakes a missing reading for priced usage", async () => {
    let reads = 0;
    const usage = await waitForPricedUsage({
      readUsage: async () => {
        reads += 1;
        return reads < 3 ? null : priced;
      },
      child: { exitCode: null },
      timeoutMs: 1000,
      intervalMs: 1,
    });
    assert.deepEqual(usage, priced);
    assert.equal(reads, 3);
  });
});
