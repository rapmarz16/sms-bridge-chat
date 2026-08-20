import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "../config.js";
import { SqliteStore } from "../db/store.js";
import { normalizePhone } from "../phone.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const config = loadConfig();
const store = new SqliteStore(config.databasePath);
const group = store.ensureDefaultGroup(config.groupName, config.voipmsDid);
const prompt = createInterface({ input: stdin, output: stdout });
try {
  const name = argument("name") ?? await prompt.question("Administrator name: ");
  const phoneInput = argument("phone") ?? await prompt.question("Mobile number: ");
  const phone = normalizePhone(phoneInput, config.defaultPhoneRegion);
  const existing = store.getMemberByPhone(phone);
  if (existing) {
    store.updateMember(existing.id, { displayName: name.trim(), role: "ADMIN", deliveryMode: "BOTH", active: true });
    stdout.write(`Updated ${name.trim()} as an administrator.\n`);
  } else {
    store.createMember({
      groupId: group.id,
      displayName: name.trim(),
      phoneNumberE164: phone,
      role: "ADMIN",
      deliveryMode: "BOTH"
    });
    stdout.write(`Created ${name.trim()} as an administrator.\n`);
  }
} finally {
  prompt.close();
  store.close();
}
