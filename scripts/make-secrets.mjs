import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const content = `# PRIVATE: do not commit or upload this file.\nAPP_SECRET=${randomBytes(48).toString("base64url")}\nSETUP_TOKEN=${randomBytes(32).toString("base64url")}\n`;
try {
  await writeFile(".dev.vars", content, { flag: "wx", mode: 0o600 });
  console.log("შეიქმნა .dev.vars. საიდუმლო მნიშვნელობები მხოლოდ ამ ფაილშია.");
  console.log("პირველი გაშვება: npx wrangler deploy --secrets-file .dev.vars");
  console.log("შემდეგი განახლებები: npm run deploy. APP_SECRET იგივე დატოვე.");
} catch (error) {
  if (error.code === "EEXIST") {
    console.error(".dev.vars უკვე არსებობს — არ გადამიწერია.");
    process.exitCode = 1;
  } else throw error;
}
