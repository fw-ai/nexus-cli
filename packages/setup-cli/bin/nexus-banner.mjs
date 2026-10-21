#!/usr/bin/env node
import process from "node:process";

import { printBanner } from "../lib/ui/banner.mjs";
import { readLocalVersion } from "../lib/system/version.mjs";

let context;
let successOnly = false;
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--context" && process.argv[i + 1]) {
    context = process.argv[i + 1];
    i += 1;
  } else if (process.argv[i] === "--success-only") {
    successOnly = true;
  }
}

const version = successOnly ? undefined : (readLocalVersion() || undefined);
printBanner({ context, version, successOnly });
