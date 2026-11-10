export class TurnLedgerStorageError extends Error {
	readonly code = "turn_storage_failure";
	constructor(cause: unknown) {
		super("Turn ledger storage failure", { cause });
	}
}
export class TurnLedgerConflictError extends Error {
	readonly code = "turn_ledger_conflict";
}
export class TurnLedgerScopeError extends Error {
	readonly code = "turn_scope_denied";
}
export function withTurnLedgerStorage<T>(operation: () => T): T {
	try {
		return operation();
	} catch (error) {
		if (
			error instanceof TurnLedgerConflictError ||
			error instanceof TurnLedgerScopeError
		)
			throw error;
		throw new TurnLedgerStorageError(error);
	}
}
