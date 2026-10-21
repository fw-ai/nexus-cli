import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createTheme } from "./theme.mjs";
import { centerBannerArt, renderBannerLine } from "./banner-render.mjs";
import { blank, success } from "./write.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNER_FILE = path.join(__dirname, "banners", "banner.txt");

export function loadBannerArt() {
  return readFileSync(BANNER_FILE, "utf8").replace(/\r\n/g, "\n").trimEnd();
}

/**
 * @param {string} art
 */
function styledBannerLines(art) {
  const theme = createTheme(process.stdout);
  return centerBannerArt(art)
    .split("\n")
    .map((line) => renderBannerLine(line, theme))
    .join("\n");
}

/**
 * @param {{ context?: string, version?: string, successOnly?: boolean }} [options]
 */
export function printBanner(options = {}) {
  if (!options.successOnly) {
    const art = loadBannerArt();
    process.stdout.write(`${styledBannerLines(art)}\n`);

    if (options.version) {
      const theme = createTheme(process.stdout);
      process.stdout.write(`${theme.muted(`v${options.version}`)}\n`);
    }
  }

  if (options.context === "install") {
    blank();
    success("Nexus is installed.");
  }
}
