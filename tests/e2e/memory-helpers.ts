import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { memoryAccounts, users } from "../../src/lib/server/db/schema";

/**
 * The e2e admin has no Memory account, so it gets the subject index (Memory
 * part 3). A spec of today's list keeps the admin on it by marking its labels
 * unverified, and puts the account back as it found it with the returned undo.
 */
export function keepAdminOnTodaysMemoryPage(): () => void {
	const admin = db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.get();
	if (!admin) throw new Error("the e2e admin is missing");
	const before = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, admin.id))
		.get();
	if (before)
		db.update(memoryAccounts)
			.set({ labelsUnverifiedEpoch: before.epoch })
			.where(eq(memoryAccounts.userId, admin.id))
			.run();
	else
		db.insert(memoryAccounts)
			.values({
				userId: admin.id,
				tenantId: `e2e-today-${admin.id}`,
				labelsUnverifiedEpoch: 0,
			})
			.run();
	return () => {
		if (before)
			db.update(memoryAccounts)
				.set({ labelsUnverifiedEpoch: before.labelsUnverifiedEpoch })
				.where(eq(memoryAccounts.userId, admin.id))
				.run();
		else
			db.delete(memoryAccounts)
				.where(eq(memoryAccounts.userId, admin.id))
				.run();
	};
}
