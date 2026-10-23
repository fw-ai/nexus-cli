import process from "node:process";
import {
  FIREWORKS_KEYS_URL,
  assertFireworksKeyUsable,
  assertNoFireworksEnvForStorage,
  persistApiKeyToKeychain,
  verifyFailureLine,
} from "../../keys/api-key.mjs";
import { activeKeySourceNote, assertBackendCanStore, keyStorageSummaryLine } from "../../keys/storage-report.mjs";
import { identityLabel } from "../../keys/verify-api-key.mjs";
import { printHarnessRows } from "../../cli/commands/harnesses.mjs";
import { HARNESS_COMMANDS } from "../../harness/id.mjs";
import { accent, bold, check } from "../../ui/term.mjs";

// Re-exported for the login flows/command that already import these from here.
export const KEYS_URL = FIREWORKS_KEYS_URL;
export { verifyFailureLine };

export function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

/**
 * @param {string} home
 * @param {string} apiKey
 */
export async function storeApiKey(home, apiKey) {
  const { backend, message } = await keyStorageSummaryLine(home);
  await assertBackendCanStore(backend, home);
  /** @type {string[]} */
  const notes = [];
  await persistApiKeyToKeychain(home, apiKey, { backend, onNote: (line) => notes.push(line) });
  return { message, notes };
}

/**
 * @param {import("../../keys/verify-api-key.mjs").VerifyResult} result
 */
export function signedInLine(result) {
  const who = identityLabel(result);
  return who ? `${check()} Signed in as ${who}.` : `${check()} Signed in.`;
}

/**
 * @param {import("../../keys/verify-api-key.mjs").VerifyResult | { email: string, accountId: string }} result
 * @param {string[]} [notes]
 */
export function printSuccessBlock(result, notes = [], { nextHint = true } = {}) {
  console.log("");
  console.log(`  ${signedInLine(result)}`);
  for (const note of notes.filter(Boolean)) {
    console.log(`  ${note}`);
  }
  console.log(`  Remove it from this machine anytime with  ${accent("nexus logout")}`);
  console.log("");
  if (nextHint) {
    printNextSteps();
  }
}

function printNextSteps() {
  const featured = HARNESS_COMMANDS.filter((row) => row.featured)
    .map(({ command, name }) => ({ command: `nexus ${command}`, name }));
  console.log(`  ${bold("Next, connect a harness:")}`);
  printHarnessRows(featured, { indent: "    ", style: accent });
  console.log("");
  console.log(`  Using another harness? See them all with  ${accent("nexus status")}`);
}

/**
 * @param {string} home
 * @param {string} key
 */
export async function loginNonInteractive(home, key) {
  if (!key) {
    fail("No key provided. Run nexus login --with-token < key.txt to sign in non-interactively.");
    return;
  }
  let result;
  try {
    assertNoFireworksEnvForStorage();
    result = await assertFireworksKeyUsable(key);
  } catch (error) {
    fail(error.message);
    return;
  }
  const stored = await storeApiKey(home, key);
  console.log(signedInLine(result));
  for (const note of [...stored.notes, activeKeySourceNote(key)].filter(Boolean)) {
    console.log(note);
  }
}
