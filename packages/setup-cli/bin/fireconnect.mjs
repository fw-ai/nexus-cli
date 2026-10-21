#!/usr/bin/env node

// Released upgraders run `bin/fireconnect.mjs finalize-install` after pulling
// the new code, so this path must keep starting the CLI.
import "./nexus.mjs";
