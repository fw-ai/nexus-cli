import process, { stdin } from "node:process";

import {
  assertNoFireworksEnvForStorage,
  resolveFireworksApiKeyValue,
  tryReadKeychainSecret,
} from "../../keys/api-key.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../../config/global-config.mjs";
import { deleteSecret, hasSecret } from "../../keys/secret-store.mjs";
import { syncBakedKeysAfterStore } from "../../keys/sync.mjs";
import { identityLabel, verifyFireworksApiKey } from "../../keys/verify-api-key.mjs";
import {
  clearMintedKeyState,
  mintedKeyName,
  readMintedKeyState,
  revokeMintedKey,
} from "../../keys/mint-api-key.mjs";
import { accent, check, link, withSpinner } from "../../ui/term.mjs";
import { runInteractiveSignIn, runSsoBrowserFlow, signInSucceeded } from "../../auth/login/flows.mjs";
import {
  fail,
  KEYS_URL,
  loginNonInteractive,
} from "../../auth/login/output.mjs";
import { promptYesNo } from "../../auth/login/prompts.mjs";
import { readShellConfig, SHELL_HOOK_BEGIN } from "../../io/shell-env-hook.mjs";

export { KEYS_URL } from "../../auth/login/output.mjs";
export {
  promptAccountChoice,
  promptAccountId,
  promptSignInMethod,
  promptYesNo,
} from "../../auth/login/prompts.mjs";
export { runInteractiveSignIn, signInSucceeded } from "../../auth/login/flows.mjs";

function requireHome(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }
  return home;
}

async function readStdinToken() {
  let data = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) {
    data += chunk;
  }
  return data.trim();
}

function printKeyRotationHints({ tty = stdin.isTTY } = {}) {
  if (tty) {
    console.log(`  Rotate without prompting:  ${accent("nexus login --force")}`);
  }
  console.log(`  Or pass a key directly:      ${accent("nexus login --api-key <key>")}`);
}

async function fireconnectExportsEnvKey(home) {
  try {
    const { raw } = await readShellConfig(home);
    return raw.includes(SHELL_HOOK_BEGIN) && raw.includes("export FIREWORKS_API_KEY");
  } catch {
    return false;
  }
}

async function printEnvKeyRotationHints(home) {
  if (await fireconnectExportsEnvKey(home)) {
    console.log("  Nexus's shell hook exports this from the keychain — login won't run while it's set.");
    console.log(`  To rotate:  ${accent("unset FIREWORKS_API_KEY")}  then  ${accent("nexus login")}`);
    console.log("  Your next shell picks up the new key automatically.");
    return;
  }
  console.log("  This key comes from your environment — login won't store behind it.");
  console.log(`  To rotate: update ${accent("FIREWORKS_API_KEY")} wherever you export it, then open a new shell.`);
  console.log(`  To store in the keychain instead:  ${accent("unset FIREWORKS_API_KEY")}  then  ${accent("nexus login")}`);
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runLoginCommand(ctx) {
  const home = requireHome(ctx);
  const explicitSignIn = ctx.withToken
    || ctx.apiKeyFromFlag
    || ctx.paste
    || Boolean(ctx.account?.trim());
  if (explicitSignIn) {
    try {
      assertNoFireworksEnvForStorage();
    } catch (error) {
      fail(error.message);
      return;
    }
  }

  if (ctx.withToken) {
    await loginNonInteractive(home, await readStdinToken());
    return;
  }

  if (ctx.apiKeyFromFlag) {
    await loginNonInteractive(home, ctx.apiKey.trim());
    return;
  }

  if (ctx.paste) {
    if (!stdin.isTTY) {
      fail("Run nexus login --with-token < key.txt to sign in non-interactively.");
      return;
    }
    await runInteractiveSignIn(home, { method: "paste" });
    return;
  }

  if (ctx.account?.trim()) {
    const handled = await runSsoBrowserFlow(home, ctx.account.trim());
    if (!handled) {
      if (!stdin.isTTY) {
        fail("Run nexus login --with-token < key.txt to sign in non-interactively.");
        return;
      }
      await runInteractiveSignIn(home, { method: "paste" });
    }
    return;
  }

  const existing = await resolveFireworksApiKeyValue({ apiKey: "", home });
  if (existing) {
    const fromEnv = existing === process.env.FIREWORKS_API_KEY?.trim();
    const result = await withSpinner("Checking your credentials…", () => verifyFireworksApiKey(existing));
    if (result.ok || result.reason !== "rejected") {
      const who = result.ok ? identityLabel(result) : "";
      const suffix = fromEnv ? " (from FIREWORKS_API_KEY)" : "";
      console.log(
        result.ok
          ? `${check()} Already signed in${who ? ` as ${who}` : ""}${suffix}.`
          : `${check()} Already signed in${suffix} (couldn't verify with the Fireworks API right now).`,
      );
      // Harness configs bake the key as a literal and go stale on rotation.
      if (result.ok) {
        for (const note of await syncBakedKeysAfterStore(home, existing)) {
          console.log(`  ${note}`);
        }
      }
      // An environment credential is intentionally ephemeral: use it as-is,
      // never offer to mint/paste/store a second key behind it.
      if (fromEnv) {
        await printEnvKeyRotationHints(home);
        return;
      }
      printKeyRotationHints();
      if (!stdin.isTTY) {
        return;
      }
      if (!ctx.force) {
        const rotate = await promptYesNo("  Sign in again and replace this machine's key?", { defaultYes: false });
        if (!rotate) {
          return;
        }
      }
    } else if (fromEnv) {
      fail(`The Fireworks API rejected the ${accent("FIREWORKS_API_KEY")} from your environment. Check or unset it to use a stored key instead.`);
      return;
    } else {
      console.log("Your stored key was rejected by the Fireworks API — let's replace it.");
    }
  }

  if (!stdin.isTTY) {
    fail("Run nexus login --with-token < key.txt to sign in non-interactively.");
    return;
  }

  await runInteractiveSignIn(home);
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runLogoutCommand(ctx) {
  const home = requireHome(ctx);
  const config = await readGlobalConfig(home);
  const hadSecret = await hasSecret(home);
  const envNote = process.env.FIREWORKS_API_KEY?.trim()
    ? `Note: FIREWORKS_API_KEY is still set in your environment; commands keep using it until you unset it.`
    : "";

  if (!hadSecret && !config.apiKey) {
    console.log("Not signed in — no stored credentials to clear.");
    if (envNote) {
      console.log(envNote);
    }
    return;
  }

  const minted = await readMintedKeyState(home);
  let revokeLine = "";
  if (minted) {
    const label = minted.displayName || "the API key created by this machine";
    let shouldRevoke = ctx.revoke;
    if (!ctx.revoke && stdin.isTTY) {
      console.log(`Browser sign-in created an API key for this machine (${accent(label)}).`);
      shouldRevoke = await promptYesNo("Revoke it too? It stops working everywhere it's used.");
    }
    if (shouldRevoke) {
      const apiKey = await tryReadKeychainSecret(home);
      if (apiKey) {
        const revoked = await withSpinner("Revoking this machine's API key…", () => revokeMintedKey({ apiKey, keyId: minted.keyId, userName: minted.userName }));
        revokeLine = revoked.ok
          ? `${check()} Revoked ${accent(label)} server-side.`
          : `Couldn't revoke ${accent(label)} — ${revoked.failure}. Revoke it at ${link(KEYS_URL)}`;
      } else {
        revokeLine = `${accent(label)} may still exist server-side — revoke it at ${link(KEYS_URL)}`;
      }
    } else {
      revokeLine = `Left ${accent(label)} active — revoke it anytime at ${link(KEYS_URL)}`;
    }
    await clearMintedKeyState(home);
  }

  await deleteSecret(home);
  if (config.apiKey) {
    await writeGlobalConfig(home, { apiKey: "" });
  }
  console.log("Logged out — removed the stored key from this machine.");
  if (revokeLine) {
    console.log(revokeLine);
  }
  if (envNote) {
    console.log(envNote);
  }
}
