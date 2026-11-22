"use strict";

const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

function readOwnerBaselineShape(databasePath, selector, expectedUserId) {
	const db = new Database(databasePath, { readonly: true, fileMustExist: true });
	try {
		db.pragma("query_only = ON");
		return db.transaction(() => {
			if (
				typeof selector !== "string" ||
				selector.length === 0 ||
				selector.trim() !== selector ||
				typeof expectedUserId !== "string" ||
				expectedUserId.length === 0
			) {
				throw new Error("identity_input_invalid");
			}
			const identities = db.prepare(`
				SELECT id, memory_enabled FROM users WHERE email COLLATE BINARY = ?
				LIMIT 2
			`).all(selector);
			if (identities.length !== 1 || identities[0].id !== expectedUserId) {
				return { status: "identity_unverified" };
			}
			const owner = identities[0];
			if (owner.memory_enabled !== 1) return { status: "memory_off" };
			const account = db.prepare(`
				SELECT authority, lifecycle_state FROM memory_accounts WHERE user_id = ?
			`).get(owner.id);
			if (account && (account.authority !== "legacy" || account.lifecycle_state !== "active")) {
				return { status: "authority_or_lifecycle_unavailable" };
			}
			const reset = db.prepare(`
				SELECT reset_generation FROM memory_reset_generations WHERE user_id = ?
			`).get(owner.id)?.reset_generation ?? 0;
			const active = db.prepare(`
				SELECT EXISTS (
					SELECT 1 FROM memory_profile_items
					WHERE user_id = ? AND reset_generation = ? AND status = 'active'
				) AS present
			`).get(owner.id, reset).present;
			const summary = db.prepare(`
				SELECT EXISTS (
					SELECT 1 FROM memory_projection_state
					WHERE user_id = ? AND reset_generation = ?
					AND scope_type = 'global' AND scope_id = ''
					AND persona_summary_text IS NOT NULL AND persona_summary_text <> ''
				) AS present
			`).get(owner.id, reset).present;
			return { status: active || summary ? "source_review_required" : "empty_legacy" };
		}).deferred();
	} finally {
		db.close();
	}
}

module.exports = { readOwnerBaselineShape };

if (require.main === module) {
	try {
		assert.equal(process.argv.length, 3);
		// Secret selector and immutable ID are provided by an owner-private file
		// through stdin. Never print either value or a SQLite exception.
		const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
		const result = readOwnerBaselineShape(process.argv[2], input.email, input.userId);
		process.stdout.write(JSON.stringify(result) + "\n");
	} catch {
		process.stdout.write('{"status":"baseline_unavailable"}\n');
		process.exitCode = 1;
	}
}
