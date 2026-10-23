import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createTheme } from "./theme.mjs";
import { centerBannerArt, renderBannerLine, stripBannerMarkup } from "./banner-render.mjs";
import { blank, success } from "./write.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNER_FILE = path.join(__dirname, "banners", "banner.txt");

export function loadBannerArt() {
  return readFileSync(BANNER_FILE, "utf8").replace(/\r\n/g, "\n").trimEnd();
}

/**
 * The logo gradient is for the install screen only; elsewhere the art prints
 * in the terminal's default color.
 * @param {string} art
 * @param {boolean} gradient
 */
function styledBannerLines(art, gradient) {
  const lines = centerBannerArt(art).split("\n");
  if (!gradient) {
    return lines.map(stripBannerMarkup).join("\n");
  }
  const theme = createTheme(process.stdout);
  const axisWidth = Math.max(0, ...lines.map((line) => stripBannerMarkup(line).length));
  return lines.map((line) => renderBannerLine(line, theme, axisWidth)).join("\n");
}

/**
 * @param {{ context?: string, version?: string, successOnly?: boolean }} [options]
 */
export function printBanner(options = {}) {
  if (!options.successOnly) {
    const art = loadBannerArt();
    process.stdout.write(`${styledBannerLines(art, options.context === "install")}\n`);

    if (options.version) {
      process.stdout.write(`v${options.version}\n`);
    }
  }

  if (options.context === "install") {
    blank();
    success("Nexus CLI is installed.");
  }
}
