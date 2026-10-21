#!/usr/bin/env node

/**
 * Detached price-cache refresher spawned by the Claude status-line helper
 * (see lib/harnesses/claude/statusline-refresh.mjs). Warms the serverless
 * catalog and the models.dev list-price caches through the shared loaders,
 * then exits. Best-effort by design: the helper already printed, failures
 * only cost a retry next turn, and nothing here may write to stdio.
 */

import "../lib/system/legacy-env.mjs";
import process from "node:process";

import { refreshPriceCaches } from "../lib/harnesses/claude/statusline-refresh.mjs";

await refreshPriceCaches({ home: process.env.HOME ?? "" }).catch(() => {});
