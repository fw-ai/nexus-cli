import process, { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { accent } from "../../ui/term.mjs";

/**
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [streams]
 * @returns {Promise<"browser" | "paste" | "sso" | null>}
 */
export async function promptSignInMethod({ stdin: in_ = stdin, stdout: out_ = stdout } = {}) {
  out_.write("\n");
  out_.write("  Nexus needs a Fireworks API key for this machine.\n");
  out_.write(`  (Removable anytime with ${accent("nexus logout", out_)}.)\n`);
  out_.write("\n");
  out_.write(`    ${accent("1", out_)}) Create one for me — opens your browser to sign in or sign up\n`);
  out_.write(`    ${accent("2", out_)}) I already have a key — paste it\n`);
  out_.write(`    ${accent("3", out_)}) My company uses custom SSO — sign in through your identity provider\n`);
  out_.write("\n");
  const rl = createInterface({ input: in_, output: out_ });
  try {
    rl.setPrompt("  Choice [1]: ");
    rl.prompt();
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === "" || answer === "1") {
        return "browser";
      }
      if (answer === "2") {
        return "paste";
      }
      if (answer === "3") {
        return "sso";
      }
      if (answer === "q" || answer === "quit") {
        return null;
      }
      out_.write("  Enter 1, 2 or 3, or q to cancel.\n");
      rl.prompt();
    }
    return null;
  } finally {
    rl.close();
  }
}

/**
 * @param {string} remembered
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [streams]
 * @returns {Promise<string | null>}
 */
export async function promptAccountId(remembered = "", { stdin: in_ = stdin, stdout: out_ = stdout } = {}) {
  out_.write("\n");
  out_.write("  Which Fireworks account should this sign-in use?\n");
  out_.write("  (The account ID your admin shared — the console's SSO login asks for the same one.)\n");
  const rl = createInterface({ input: in_, output: out_ });
  try {
    rl.setPrompt(remembered ? `  Account ID [${remembered}]: ` : "  Account ID: ");
    rl.prompt();
    for await (const line of rl) {
      const answer = line.trim();
      if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
        return null;
      }
      if (answer) {
        return answer;
      }
      if (remembered) {
        return remembered;
      }
      out_.write("  Enter your account ID, or q to cancel.\n");
      rl.prompt();
    }
    return null;
  } finally {
    rl.close();
  }
}

/**
 * @param {string} question
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, defaultYes?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function promptYesNo(question, { stdin: in_ = stdin, stdout: out_ = stdout, defaultYes = true } = {}) {
  const rl = createInterface({ input: in_, output: out_ });
  try {
    rl.setPrompt(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `);
    rl.prompt();
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        return true;
      }
      if (answer === "n" || answer === "no") {
        return false;
      }
      if (answer === "") {
        return defaultYes;
      }
      out_.write("  Enter y or n.\n");
      rl.prompt();
    }
    return false;
  } finally {
    rl.close();
  }
}

function accountLabel(name) {
  return name.startsWith("accounts/") ? name.slice("accounts/".length) : name;
}

/**
 * @param {string[]} accountNames
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [streams]
 * @returns {Promise<number|null>}
 */
export async function promptAccountChoice(accountNames, { stdin: in_ = stdin, stdout: out_ = stdout } = {}) {
  out_.write("\n");
  out_.write("  Your sign-in is linked to more than one Fireworks account. Which one should this key belong to?\n");
  out_.write("\n");
  accountNames.forEach((name, i) => {
    out_.write(`    ${accent(String(i + 1), out_)}) ${accountLabel(name)}\n`);
  });
  out_.write("\n");
  const rl = createInterface({ input: in_, output: out_ });
  try {
    rl.setPrompt("  Choice [1]: ");
    rl.prompt();
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === "" || answer === "1") {
        return 0;
      }
      if (answer === "q" || answer === "quit") {
        return null;
      }
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= accountNames.length) {
        return n - 1;
      }
      out_.write(`  Enter 1 to ${accountNames.length}, or q to cancel.\n`);
      rl.prompt();
    }
    return null;
  } finally {
    rl.close();
  }
}
