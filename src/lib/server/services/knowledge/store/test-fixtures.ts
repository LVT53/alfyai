import { vi } from "vitest";

type RowFixture = Record<string, unknown>;

const DEFAULT_DATE = new Date("2024-01-01T00:00:00Z");

export function makeArtifactRow(overrides: RowFixture = {}): RowFixture {
	return {
		id: "artifact-1",
		userId: "user-1",
		type: "source_document",
		conversationId: null,
		storagePath: null,
		metadataJson: null,
		createdAt: DEFAULT_DATE,
		updatedAt: DEFAULT_DATE,
		...overrides,
	};
}

export function makeSelectResult(rows: Array<RowFixture>) {
	return {
		from: vi.fn(() => ({
			where: vi.fn(async () => rows),
		})),
	};
}

export function makeSelectLimitResult(rows: Array<RowFixture>) {
	return {
		from: vi.fn(() => ({
			where: vi.fn(() => ({
				limit: vi.fn(() => Promise.resolve(rows)),
			})),
		})),
	};
}

export function makeSelectOrderByResult(rows: Array<RowFixture>) {
	return {
		from: vi.fn(() => ({
			where: vi.fn(() => ({
				orderBy: vi.fn(async () => rows),
			})),
		})),
	};
}

export function queueMockResponses(
	mockFn: { mockImplementation: (impl: () => unknown) => unknown },
	responses: Array<unknown | (() => unknown)>,
) {
	let callIndex = 0;

	mockFn.mockImplementation(() => {
		const response =
			responses[callIndex] ?? responses[responses.length - 1] ?? undefined;
		callIndex += 1;
		return typeof response === "function" ? response() : response;
	});
}

export function makeInsertChain<T extends RowFixture>(rows: Array<T>) {
	const returning = vi.fn(() => Promise.resolve(rows));

	return {
		values: vi.fn(() => ({
			returning,
		})),
		returning,
	};
}

export function makeTransactionStub() {
	const tx = {
		delete: vi.fn(() => ({
			where: vi.fn(() => ({
				run: vi.fn(),
			})),
		})),
	};

	return {
		tx,
		transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<void>) => {
			await callback(tx);
		}),
	};
}

export function makeFileFixture(name: string, type: string, size: number) {
	return {
		name,
		size,
		type,
		arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(size))),
	} as unknown as File;
}
