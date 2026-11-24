#!/usr/bin/env tsx
/**
 * Memory part 2 rollback. Puts every bank this release moved to bank config 2
 * back on config 1 (labels cleared) and its stored version back to the engine
 * commit, so the previous release can serve Memory again. Inspects by default
 * and prints counts only. Run from THIS release's checkout, with the app's
 * environment loaded and its Memory workers stopped, before the previous
 * release starts (deploy/hindsight/README.md, "Bank config 2").
 *
 *   npx tsx scripts/memory-bank-config-restore.ts
 *   npx tsx scripts/memory-bank-config-restore.ts --execute restore-bank-config-1
 */
import { restoreBankConfigs } from "../src/lib/server/services/memory-profile/bank-config-restore";

const args = process.argv.slice(2);
const execute =
	args.length === 2 &&
	args[0] === "--execute" &&
	args[1] === "restore-bank-config-1";
if (args.length && !execute) {
	console.error(
		"usage: memory-bank-config-restore.ts [--execute restore-bank-config-1]",
	);
	process.exit(2);
}
console.log(JSON.stringify(await restoreBankConfigs({ execute })));
