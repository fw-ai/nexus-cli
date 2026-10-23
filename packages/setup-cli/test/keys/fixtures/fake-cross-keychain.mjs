import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Stands in for cross-keychain: a Secret Service that is always listed. Also
// stands in for keychain-item-probe.mjs, the attribute-only macOS lookup
// (logged as `itemExists`), which never reads the secret.
// FAKE_KEYCHAIN=broken refuses writes (no default collection), working keeps
// secrets, forgetful accepts writes and keeps nothing.
// FAKE_KEYCHAIN_BACKEND names the listed native backend (default
// secret-service), and FAKE_KEYCHAIN_LOG, when set, gets one line per call
// (`getPassword`, `itemExists`) so specs can count secret reads.
const mode = process.env.FAKE_KEYCHAIN;
const logCall = (op) => {
  if (process.env.FAKE_KEYCHAIN_LOG) {
    appendFileSync(process.env.FAKE_KEYCHAIN_LOG, `${op}\n`);
  }
};
const storePath = () => path.join(process.env.HOME, "fake-keychain.json");
const readStore = () => {
  try {
    return JSON.parse(readFileSync(storePath(), "utf8"));
  } catch {
    return {};
  }
};

export async function resolve(specifier, context, nextResolve) {
  return specifier === "cross-keychain" || specifier.endsWith("/keychain-item-probe.mjs")
    ? { url: import.meta.url, shortCircuit: true }
    : nextResolve(specifier, context);
}

export async function macKeychainItemExists(service, account) {
  logCall("itemExists");
  return mode === "working" && Object.hasOwn(readStore(), `${service}/${account}`);
}

export async function listBackends() {
  return [{ id: process.env.FAKE_KEYCHAIN_BACKEND || "secret-service", priority: 5 }, { id: "file", priority: 1 }];
}

export async function setPassword(service, account, value) {
  if (mode === "broken") {
    throw new Error("Secret Service: no result found");
  }
  if (mode === "working") {
    writeFileSync(storePath(), JSON.stringify({ ...readStore(), [`${service}/${account}`]: value }));
  }
}

export async function getPassword(service, account) {
  logCall("getPassword");
  return mode === "working" ? readStore()[`${service}/${account}`] ?? null : null;
}

export async function deletePassword(service, account) {
  if (mode !== "working") {
    return;
  }
  const store = readStore();
  delete store[`${service}/${account}`];
  writeFileSync(storePath(), JSON.stringify(store));
}

export function dataRoot() {
  return "";
}
