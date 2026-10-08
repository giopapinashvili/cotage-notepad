import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

let setupToken;
try {
  const existing = await readFile(".dev.vars", "utf8");
  setupToken = existing.match(/^SETUP_TOKEN=(.+)$/m)?.[1];
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (!setupToken || setupToken.length < 24)
  setupToken = randomBytes(32).toString("base64url");

await writeFile(
  ".dev.vars",
  `# PRIVATE: do not commit or upload this file.\nSETUP_TOKEN=${setupToken}\n`,
  { mode: 0o600 }
);
console.log(".dev.vars მზადაა. დამატებითი სერვერის კოდი საჭირო არ არის.");
console.log("პირველი განთავსება: npx wrangler deploy --secrets-file .dev.vars");
console.log("შემდეგი განახლებები: npm run deploy.");
