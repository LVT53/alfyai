import { vi } from "vitest";
import "@testing-library/jest-dom";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";

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
