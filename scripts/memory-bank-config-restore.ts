#!/usr/bin/env tsx
/**
 * The rollback of the Memory bank config. Puts every bank this release moved
 * to bank config 3 back on config 2 (`restore-bank-config-2`, for a rollback
 * to the release before this one), or every bank on config 3 or 2 back on
 * config 1 with its labels cleared (`restore-bank-config-1`, for a rollback
 * to the first release), and sets each stored version to match, so the
 * earlier release can serve Memory again. Inspects by default and prints
 * counts only. Run from THIS release's checkout, with the app's environment
 * loaded and its Memory workers stopped, before the earlier release starts
 * (deploy/hindsight/README.md, "Bank config 3").
 *
 *   npx tsx scripts/memory-bank-config-restore.ts
 *   npx tsx scripts/memory-bank-config-restore.ts --execute restore-bank-config-2
 *   npx tsx scripts/memory-bank-config-restore.ts --execute restore-bank-config-1
 */
import { restoreBankConfigs } from "../src/lib/server/services/memory-profile/bank-config-restore";

const args = process.argv.slice(2);
const target =
	args.length === 2 && args[0] === "--execute"
		? (
				{
					"restore-bank-config-1": 1,
					"restore-bank-config-2": 2,
				} as const
			)[args[1] as "restore-bank-config-1"]
		: undefined;
if (args.length && !target) {
	console.error(
		"usage: memory-bank-config-restore.ts [--execute restore-bank-config-1|restore-bank-config-2]",
	);
	process.exit(2);
}
console.log(
	JSON.stringify(
		await restoreBankConfigs({ execute: target !== undefined, to: target }),
	),
);
