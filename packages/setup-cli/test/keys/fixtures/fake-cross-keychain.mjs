import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Stands in for cross-keychain: a Secret Service that is always listed.
// FAKE_KEYCHAIN=broken refuses writes (no default collection), working keeps
// secrets, forgetful accepts writes and keeps nothing.
const mode = process.env.FAKE_KEYCHAIN;
const storePath = () => path.join(process.env.HOME, "fake-keychain.json");
const readStore = () => {
  try {
    return JSON.parse(readFileSync(storePath(), "utf8"));
  } catch {
    return {};
  }
};

export async function resolve(specifier, context, nextResolve) {
  return specifier === "cross-keychain"
    ? { url: import.meta.url, shortCircuit: true }
    : nextResolve(specifier, context);
}

export async function listBackends() {
  return [{ id: "secret-service", priority: 5 }, { id: "file", priority: 1 }];
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
  return mode === "working" ? readStore()[`${service}/${account}`] ?? null : null;
}

export async function deletePassword() {}

export function dataRoot() {
  return "";
}
