// Run this yourself on a trusted local computer. Never run it in a public preview.
// It writes private, git-ignored files and never prints credential values.
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("./", import.meta.url);
const passwordFile = new URL("credentials.private.txt", root);
const varsFile = new URL(".dev.vars", root);
if (existsSync(passwordFile) || existsSync(varsFile)) {
  console.error("Refusing to overwrite existing private credentials. Move them to a secure backup before rotating.");
  process.exit(1);
}
const password = randomBytes(32).toString("base64url");
const hash = `sha256$${createHash("sha256").update(password).digest("hex")}`;
const secret = randomBytes(32).toString("hex");
writeFileSync(
  passwordFile,
  `Administrator password (save in your password manager):\n${password}\n\nDo not upload, commit, or send this file in chat.\n`,
  { mode: 0o600, flag: "wx" }
);
writeFileSync(varsFile, `ADMIN_PASSWORD_HASH="${hash}"\nANALYTICS_SECRET="${secret}"\n`, { mode: 0o600, flag: "wx" });
console.log(`Created ${fileURLToPath(passwordFile)} and ${fileURLToPath(varsFile)} with owner-only permissions.`);
console.log("Save the password privately. Copy only the two .dev.vars values into matching Cloudflare Secret bindings.");
console.log("Keep .dev.vars private. Never put either value in wrangler.toml, website JavaScript, GitHub, or chat.");
