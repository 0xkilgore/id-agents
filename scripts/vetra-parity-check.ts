import { createDb } from "../src/db/index.js";
import { sqliteRowToParityShape } from "../src/vetra/parity.js";

const hoursIndex = process.argv.indexOf("--hours");
const hours = hoursIndex === -1 ? 24 : Number(process.argv[hoursIndex + 1]);
const since = Date.now() - hours * 60 * 60 * 1000;

const db = await createDb();
const rows = await db.dispatches.list({ since, limit: 500 });
for (const row of rows) {
  const shape = sqliteRowToParityShape(row);
  console.log(`dispatch ${shape.dispatch_id}: OK`);
}
await db.close();
