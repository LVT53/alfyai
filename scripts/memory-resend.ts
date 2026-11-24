#!/usr/bin/env tsx
/**
 * Resend one chat's Memory delivery under a new operation: for a delivery that
 * failed for good because its retain never landed in Hindsight. A dry run
 * unless --execute; refuses the tester account (the permanent tester rule).
 * Prints every step's result and the report (counts and ids only). Run from
 * this release's checkout with the app's environment loaded.
 *
 *   npx tsx scripts/memory-resend.ts --user <id> --job <delivery job id> [--execute]
 */
import { resendDelivery } from "../src/lib/server/services/memory-profile/operator-tools";
import { runOperatorCli } from "./memory-operator-cli";

await runOperatorCli(
	"job",
	"usage: npx tsx scripts/memory-resend.ts --user <id> --job <id> [--execute]",
	(args) =>
		resendDelivery({
			userId: args.user,
			jobId: args.job as string,
			execute: args.execute,
		}),
);
