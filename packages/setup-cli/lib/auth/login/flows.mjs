import process, { stdin } from "node:process";

import { signInViaDeviceFlow, signInViaLocalhostCallback } from "../browser-auth.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../../config/global-config.mjs";
import {
  assertNoFireworksEnvForStorage,
  resolveFireworksApiKeyValue,
} from "../../keys/api-key.mjs";
import { readSecret } from "../../ui/read-secret.mjs";
import {
  FIREPASS_KEY_UNSUPPORTED_MESSAGE,
  isFirePassKey,
  isFireworksShapedKey,
} from "../../keys/key-type.mjs";
import { createUserJit, getOAuthArgumentsForAccount } from "../sso-account.mjs";
import {
  BROWSER_SIGNIN_NO_ACCOUNT_FAILURE,
  listAccountsForIdToken,
  mintApiKeyForAccount,
  mintedKeyName,
  writeMintedKeyState,
} from "../../keys/mint-api-key.mjs";
import { verifyFireworksApiKey } from "../../keys/verify-api-key.mjs";
import { accent, link, openInBrowser, withSpinner } from "../../ui/term.mjs";
import {
  fail,
  KEYS_URL,
  printSuccessBlock,
  storeApiKey,
  verifyFailureLine,
} from "./output.mjs";
import { activeKeySourceNote } from "../../keys/storage-report.mjs";
import {
  promptAccountChoice,
  promptAccountId,
  promptSignInMethod,
} from "./prompts.mjs";

const MAX_PASTE_ATTEMPTS = 3;

async function completeMintedSignIn(home, {
  idToken,
  email,
  accountName,
  fallbackAccountId = "",
  rememberSsoAccountId = "",
  nextHint = true,
  say,
}) {
  const outcome = await withSpinner("Signing you in…", async () => {
    const mint = await mintApiKeyForAccount(idToken, accountName, { email });
    if (!mint.ok) {
      return { failure: mint.failure };
    }
    const verify = await verifyFireworksApiKey(mint.key);
    if (!verify.ok && verify.reason === "rejected") {
      return { failure: "The Fireworks API rejected the key that was just created for you. Try again in a moment." };
    }
    return { mint, verify };
  });
  if (outcome.failure) {
    say(outcome.failure);
    return false;
  }

  const stored = await storeApiKey(home, outcome.mint.key);
  await writeMintedKeyState(home, {
    keyId: outcome.mint.keyId,
    userName: outcome.mint.userName,
    displayName: mintedKeyName(),
  });
  if (rememberSsoAccountId) {
    await writeGlobalConfig(home, { ssoAccountId: rememberSsoAccountId });
  }
  const identity = outcome.verify.ok ? outcome.verify : { email, accountId: fallbackAccountId };
  printSuccessBlock(identity, [
    `Created API key ${accent(mintedKeyName())} — revoke anytime at ${link(KEYS_URL)}`,
    stored.message,
    ...stored.notes,
    activeKeySourceNote(outcome.mint.key),
  ], { nextHint });
  return true;
}

async function runBrowserFlow(home, { nextHint = true } = {}) {
  const say = (line) => console.log(`  ${line}`);
  console.log("");

  const flows = [
    () => signInViaLocalhostCallback({ onStatus: say }),
    () => signInViaDeviceFlow({ onStatus: say }),
  ];

  let tokens = null;
  for (const flow of flows) {
    const result = await flow();
    if (result.ok) {
      tokens = result;
      break;
    }
    if (result.fatal) {
      fail(`  ${result.failure} Run ${accent("nexus login")} to try again.`);
      return true;
    }
    say(result.failure);
  }
  if (!tokens) {
    say("Switching to key paste.");
    return false;
  }

  const listed = await listAccountsForIdToken(tokens.idToken);
  let accountName = "";
  let accountFailure = "";
  if (!listed.ok) {
    accountFailure = listed.failure;
  } else if (listed.accountNames.length === 0) {
    accountFailure = BROWSER_SIGNIN_NO_ACCOUNT_FAILURE;
  } else if (listed.accountNames.length > 1) {
    const idx = await promptAccountChoice(listed.accountNames);
    if (idx === null) {
      accountFailure = "Sign-in cancelled — no account selected.";
    } else {
      accountName = listed.accountNames[idx];
    }
  } else {
    accountName = listed.accountNames[0];
  }

  if (accountFailure) {
    say(accountFailure);
    say("Switching to key paste.");
    return false;
  }
  const completed = await completeMintedSignIn(home, {
    idToken: tokens.idToken,
    email: tokens.email,
    accountName,
    nextHint,
    say,
  });
  if (!completed) {
    say("Switching to key paste.");
    return false;
  }
  return true;
}

async function runSsoBrowserFlow(home, accountId, { nextHint = true } = {}) {
  const say = (line) => console.log(`  ${line}`);
  console.log("");

  const args = await getOAuthArgumentsForAccount(accountId);
  if (!args.ok) {
    fail(`  ${args.failure}`);
    return true;
  }

  say(`Signing in through ${accent(accountId)}'s identity provider…`);
  const tokens = await signInViaLocalhostCallback({
    onStatus: say,
    cognitoDomain: args.cognitoDomain,
    clientId: args.clientId,
  });
  if (!tokens.ok) {
    if (tokens.fatal) {
      fail(`  ${tokens.failure} Run ${accent(`nexus login --account ${accountId}`)} to try again.`);
      return true;
    }
    say(tokens.failure);
    say("Switching to key paste.");
    return false;
  }

  const jit = await createUserJit(tokens.idToken, accountId);
  if (!jit.ok) {
    fail(`  ${jit.failure}`);
    return true;
  }

  const completed = await completeMintedSignIn(home, {
    idToken: tokens.idToken,
    email: tokens.email,
    accountName: `accounts/${accountId}`,
    fallbackAccountId: accountId,
    rememberSsoAccountId: accountId,
    nextHint,
    say,
  });
  if (!completed) {
    say("Switching to key paste.");
    return false;
  }
  return true;
}

async function runPasteFlow(home, { nextHint = true } = {}) {
  console.log("");
  console.log(`  Get a key from  ${link(KEYS_URL)}`);
  console.log("  Press Enter to open that page in your browser, or paste your key below.");
  console.log("");

  let openedBrowser = false;
  let attempts = 0;
  while (attempts < MAX_PASTE_ATTEMPTS) {
    const key = await readSecret("  Paste your Fireworks API key: ", { allowEmpty: true });

    if (!key) {
      if (!openedBrowser) {
        openedBrowser = true;
        const opened = await openInBrowser(KEYS_URL);
        console.log(
          opened
            ? "  Opened your browser — create a key there, then paste it here."
            : `  Couldn't open a browser. Visit ${link(KEYS_URL)}, then paste the key here.`,
        );
        continue;
      }
      attempts += 1;
      continue;
    }

    if (isFirePassKey(key)) {
      attempts += 1;
      console.log(`  ${FIREPASS_KEY_UNSUPPORTED_MESSAGE}`);
      continue;
    }
    if (!isFireworksShapedKey(key)) {
      attempts += 1;
      console.log(
        `  That doesn't look like a Fireworks key (expected it to start with fw_). `
        + `Try again, or get one at ${link(KEYS_URL)}`,
      );
      continue;
    }

    const result = await withSpinner("Checking your key…", () => verifyFireworksApiKey(key));
    if (result.ok) {
      const stored = await storeApiKey(home, key);
      printSuccessBlock(result, [stored.message, ...stored.notes, activeKeySourceNote(key)], { nextHint });
      return;
    }
    attempts += 1;
    console.log(`  ${verifyFailureLine(result, { interactive: true })}`);
  }

  fail(`Sign-in not completed. Run ${accent("nexus login")} to try again.`);
}

/**
 * @param {string} home
 * @param {{ nextHint?: boolean, method?: "browser" | "paste" | "sso" }} [options]
 * @returns {Promise<boolean>}
 */
export async function runInteractiveSignIn(home, { nextHint = true, method: chosen } = {}) {
  assertNoFireworksEnvForStorage();
  const method = chosen ?? await promptSignInMethod();
  if (!method) {
    fail(`Sign-in cancelled. Run ${accent("nexus login")} when you're ready.`);
    return false;
  }

  let handled = false;
  if (method === "browser") {
    handled = await runBrowserFlow(home, { nextHint });
  }
  if (method === "sso") {
    const remembered = (await readGlobalConfig(home)).ssoAccountId;
    const accountId = await promptAccountId(remembered);
    if (!accountId) {
      fail(`Sign-in cancelled. Run ${accent("nexus login")} when you're ready.`);
      return false;
    }
    handled = await runSsoBrowserFlow(home, accountId, { nextHint });
  }
  if (!handled) {
    await runPasteFlow(home, { nextHint });
  }

  return signInSucceeded(home);
}

/**
 * @param {string} home
 * @returns {Promise<boolean>}
 */
export async function signInSucceeded(home) {
  const stored = await resolveFireworksApiKeyValue({ apiKey: "", home });
  if (!stored) {
    return false;
  }
  const result = await verifyFireworksApiKey(stored);
  return result.ok || result.reason !== "rejected";
}

export { runSsoBrowserFlow };
