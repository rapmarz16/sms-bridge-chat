import { loadConfig } from "../config.js";
import { SqliteStore } from "../db/store.js";

const config = loadConfig();
const store = new SqliteStore(config.databasePath);
store.ensureDefaultGroup(config.groupName, config.voipmsDid);
store.close();
process.stdout.write("Database migrations complete.\n");
