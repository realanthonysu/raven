import { execSync } from "node:child_process";
import { statSync } from "node:fs";

const MAX_SIZE = 500 * 1024; // 500KB

const files = execSync("git diff --cached --name-only --diff-filter=A", {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

let failed = false;
for (const file of files) {
  try {
    const size = statSync(file).size;
    if (size > MAX_SIZE) {
      console.error(`ERROR: ${file} too large (${Math.round(size / 1024)}KB, max 500KB)`);
      failed = true;
    }
  } catch {
    // file not found locally (e.g. deleted after staging), skip
  }
}

process.exit(failed ? 1 : 0);
