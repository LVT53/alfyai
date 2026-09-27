import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, inject, vi } from "vitest";
import "@testing-library/jest-dom";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";

// Some components kick off a dynamic import() from inside an effect (e.g.
// ArtifactCard's lazy FileProductionCard body). Testing Library's own
// afterEach unmounts the component, but the import's module-graph transform
// keeps running in the background; if a test file's environment is torn
// down before it settles, Vitest reports an "EnvironmentTeardownError" that
// gets attributed to whatever test happens to be running when the stray
// promise resolves, not to the test that actually started the import. This
// runs after every test, everywhere, so that race can never cross a test or
// file boundary. See ArtifactCard.svelte's own effect for the matching
// component-side guard against setting state after it is no longer live.
afterEach(async () => {
	await vi.dynamicImportSettled();
});

// Point the shared `db` singleton (src/lib/server/db/index.ts) at a private
// copy of the fully migrated throwaway database provisioned by
// src/vitest-global-setup.ts. This is unconditional on purpose: the suite
// must never open a developer's real ./data/chat.db, whatever DATABASE_PATH
// happens to be in the shell.
//
// Each Vitest worker (a separate OS thread or process) runs this file's
// module-level code once per test file, and every one of them would
// otherwise point `db/index.ts`'s WAL-mode better-sqlite3 connection at the
// exact same template file. Two connections writing that one file from
// separate processes can hit an immediate `SQLITE_BUSY` "database is locked"
// on an ordinary snapshot conflict -- no busy-timeout retry can help, because
// nothing is holding a lock to wait out. So give each worker its own copy of
// the template, made once (the first test file that worker runs) and reused
// by every later file in that same worker, exactly like every test file
// already reused one shared database before this change -- just partitioned
// so no two live connections ever point at the same file at once.
const templateDatabasePath = inject("alfyaiTestDatabasePath");
const workerId = process.env.VITEST_POOL_ID ?? String(process.pid);
const workerDatabasePath = join(
	dirname(templateDatabasePath),
	`chat-worker-${workerId}.db`,
);
if (!existsSync(workerDatabasePath)) {
	copyFileSync(templateDatabasePath, workerDatabasePath);
}
process.env.DATABASE_PATH = workerDatabasePath;

if (!Element.prototype.animate) {
	Object.defineProperty(Element.prototype, "animate", {
		writable: true,
		value: vi.fn(() => ({
			finished: Promise.resolve(),
			cancel: vi.fn(),
			finish: vi.fn(),
			play: vi.fn(),
			pause: vi.fn(),
			reverse: vi.fn(),
			commitStyles: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	});
}

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
	writable: true,
	value: vi.fn(() => ({
		clearRect: vi.fn(),
		drawImage: vi.fn(),
		fillRect: vi.fn(),
		fillText: vi.fn(),
		getImageData: vi.fn(),
		putImageData: vi.fn(),
		measureText: vi.fn(() => ({ width: 0 })),
		restore: vi.fn(),
		save: vi.fn(),
		scale: vi.fn(),
		setTransform: vi.fn(),
		stroke: vi.fn(),
		translate: vi.fn(),
	})),
});

if (!URL.createObjectURL) {
	Object.defineProperty(URL, "createObjectURL", {
		writable: true,
		value: vi.fn(() => "blob:mock-url"),
	});
}

if (!URL.revokeObjectURL) {
	Object.defineProperty(URL, "revokeObjectURL", {
		writable: true,
		value: vi.fn(),
	});
}

// Mock IntersectionObserver for PDF viewer scroll tracking
class MockIntersectionObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
	takeRecords = vi.fn(() => []);
	root = null;
	rootMargin = "";
	thresholds = [];
}

Object.defineProperty(global, "IntersectionObserver", {
	writable: true,
	value: MockIntersectionObserver,
});

// Mock localStorage for components that persist state
const localStorageMock = (() => {
	let store: Record<string, string> = {};
	return {
		getItem: vi.fn((key: string) => store[key] || null),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
		get length() {
			return Object.keys(store).length;
		},
		key: vi.fn((index: number) => Object.keys(store)[index] || null),
	};
})();

Object.defineProperty(global, "localStorage", {
	writable: true,
	value: localStorageMock,
});
