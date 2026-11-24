#!/usr/bin/env tsx
/**
 * Reset facts stuck in consolidation in one Memory bank: Hindsight's
 * POST …/consolidation/recover, then one consolidation, then the failed facts
 * counted again. Only on a quiet bank. A dry run unless --execute; refuses the
 * tester account (the permanent tester rule). Prints every step's result and
 * the report (counts and ids only). Run from this release's checkout with the
 * app's environment loaded.
 *
 *   npx tsx scripts/memory-recover-consolidation.ts --user <id> --bank <bank id> [--execute]
 */
import { recoverConsolidation } from "../src/lib/server/services/memory-profile/operator-tools";
import { runOperatorCli } from "./memory-operator-cli";

await runOperatorCli(
	"bank",
	"usage: npx tsx scripts/memory-recover-consolidation.ts --user <id> --bank <id> [--execute]",
	(args) =>
		recoverConsolidation({
			userId: args.user,
			bankId: args.bank as string,
			execute: args.execute,
		}),
);
