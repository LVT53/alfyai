import type { Container } from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dockerode
const mockContainer = {
	start: vi.fn().mockResolvedValue(undefined),
	kill: vi.fn().mockResolvedValue(undefined),
	stop: vi.fn().mockResolvedValue(undefined),
	remove: vi.fn().mockResolvedValue(undefined),
	exec: vi.fn().mockResolvedValue({
		start: vi.fn().mockResolvedValue(undefined),
	}),
	wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
};

const mockImageInspect = vi.fn().mockResolvedValue({ Id: "image-1" });
const mockPull = vi.fn().mockResolvedValue({ on: vi.fn() });
const mockFollowProgress = vi.fn(
	(_stream, onFinished: (err: Error | null, output?: unknown) => void) =>
		onFinished(null, []),
);
const mockDemuxStream = vi.fn();

const mockDocker = {
	createContainer: vi.fn().mockResolvedValue(mockContainer),
	getContainer: vi.fn().mockReturnValue(mockContainer),
	getImage: vi.fn().mockReturnValue({
		inspect: mockImageInspect,
	}),
	pull: mockPull,
	modem: {
		followProgress: mockFollowProgress,
		demuxStream: mockDemuxStream,
	},
};

vi.mock("dockerode", () => ({
	// biome-ignore lint/complexity/useArrowFunction: mock must be a regular function so `new Docker()` works in Vitest 4
	default: vi.fn().mockImplementation(function () {
		return mockDocker;
	}),
}));

const {
	createSandbox,
	destroySandbox,
	prewarmSandboxImageInBackground,
	resetSandboxImageStateForTests,
	SANDBOX_TIMEOUT_MS,
	SANDBOX_TIMEOUT_JS_MS,
	getSandboxTimeout,
	SANDBOX_MEMORY_MB,
	SANDBOX_MAX_FILE_MB,
} = await import("./config");
describe("sandbox config", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetSandboxImageStateForTests();
		mockImageInspect.mockResolvedValue({ Id: "image-1" });
		mockPull.mockResolvedValue({ on: vi.fn() });
		mockDemuxStream.mockImplementation(() => undefined);
		mockContainer.kill.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("configuration constants", () => {
		it("should have correct timeout value (90 seconds)", () => {
			expect(SANDBOX_TIMEOUT_MS).toBe(90000);
		});

		it("should have correct JS timeout value (135 seconds)", () => {
			expect(SANDBOX_TIMEOUT_JS_MS).toBe(135000);
		});

		it("should return JS timeout for javascript language", () => {
			expect(getSandboxTimeout("javascript")).toBe(135000);
		});

		it("should return default timeout for python language", () => {
			expect(getSandboxTimeout("python")).toBe(90000);
		});
		it("should have correct memory limit (2GB)", () => {
			expect(SANDBOX_MEMORY_MB).toBe(2048);
		});

		it("should have correct max file size (100MB)", () => {
			expect(SANDBOX_MAX_FILE_MB).toBe(100);
		});
	});

	describe("createSandbox", () => {
		it("should create a sandbox container with Python runtime", async () => {
			const sandbox = await createSandbox();

			expect(mockDocker.getImage).toHaveBeenCalledWith("python:3.11-slim");
			expect(mockImageInspect).toHaveBeenCalled();
			expect(mockDocker.createContainer).toHaveBeenCalledWith(
				expect.objectContaining({
					Image: expect.stringContaining("python"),
					Cmd: expect.arrayContaining(["python3"]),
					HostConfig: expect.objectContaining({
						Memory: 2048 * 1024 * 1024, // 2GB in bytes
						NetworkMode: "none", // No network access
						AutoRemove: true,
					}),
				}),
			);
			expect(sandbox).toHaveProperty("container");
			expect(sandbox).toHaveProperty("execute");
			expect(sandbox).toHaveProperty("destroy");
		});

		// `StopTimeout` is how long docker waits after SIGTERM before it
		// escalates. It read `getSandboxTimeout()` directly, which stopped being
		// the run's deadline the moment `FILE_PRODUCTION_SANDBOX_TIMEOUT_MS` was
		// wired: a job the admin had given ten minutes was created with a
		// ninety-second grace, so the two halves of "how long may this run"
		// disagreed. One resolver now feeds both.
		it("gives the container the same deadline the kill uses", async () => {
			await createSandbox("python", 600_000);

			expect(mockDocker.createContainer).toHaveBeenCalledWith(
				expect.objectContaining({ StopTimeout: 600 }),
			);
		});

		it("keeps the language default when no deadline is passed", async () => {
			// `run_python` passes none, and its envelope timeout is derived from
			// this same constant.
			await createSandbox("python");
			expect(mockDocker.createContainer).toHaveBeenCalledWith(
				expect.objectContaining({ StopTimeout: 90 }),
			);

			mockDocker.createContainer.mockClear();
			await createSandbox("javascript");
			expect(mockDocker.createContainer).toHaveBeenCalledWith(
				expect.objectContaining({ StopTimeout: 135 }),
			);
		});

		it("should enforce resource limits on container", async () => {
			await createSandbox();

			const createCall = mockDocker.createContainer.mock.calls[0][0];
			expect(createCall.HostConfig).toMatchObject({
				Memory: 2048 * 1024 * 1024, // 2GB
				MemorySwap: 2048 * 1024 * 1024, // No swap
				CpuQuota: 100000, // 1 CPU core
				NetworkMode: "none", // Isolated network
				AutoRemove: true,
			});
		});

		it("should disable network access for security", async () => {
			await createSandbox();

			const createCall = mockDocker.createContainer.mock.calls[0][0];
			expect(createCall.HostConfig.NetworkMode).toBe("none");
		});

		it("pulls the sandbox image when it is missing locally", async () => {
			mockImageInspect.mockRejectedValueOnce({
				statusCode: 404,
				json: { message: "No such image: python:3.11-slim" },
			});

			await createSandbox();

			expect(mockPull).toHaveBeenCalledWith("python:3.11-slim");
			expect(mockFollowProgress).toHaveBeenCalled();
			expect(mockDocker.createContainer).toHaveBeenCalled();
		});

		it("warms the sandbox image in the background without duplicate work", async () => {
			prewarmSandboxImageInBackground();
			prewarmSandboxImageInBackground();
			await Promise.resolve();

			expect(mockDocker.getImage).toHaveBeenCalledWith("python:3.11-slim");
			expect(mockDocker.getImage).toHaveBeenCalledWith("node:22-bookworm-slim");
			expect(mockImageInspect).toHaveBeenCalledTimes(2);
			expect(mockPull).not.toHaveBeenCalled();
		});

		it("should create a sandbox container with JavaScript runtime", async () => {
			await createSandbox("javascript");

			expect(mockDocker.getImage).toHaveBeenCalledWith("node:22-bookworm-slim");
			expect(mockDocker.createContainer).toHaveBeenCalledWith(
				expect.objectContaining({
					Image: "node:22-bookworm-slim",
					Cmd: ["node", "-e", "process.stdin.resume()"],
					WorkingDir: "/workspace",
					HostConfig: expect.objectContaining({
						Binds: expect.arrayContaining([
							expect.stringContaining("/workspace/node_modules:ro"),
						]),
					}),
				}),
			);
		});
	});

	describe("sandbox execution", () => {
		it("should execute simple Python code", async () => {
			const mockExecInspect = vi.fn().mockResolvedValue({
				ExitCode: 0,
				Running: false,
			});

			const mockStream = {
				once: vi.fn().mockImplementation((event: string, handler: unknown) => {
					if (event === "end") {
						setTimeout(() => (handler as () => void)(), 0);
					}
					return mockStream;
				}),
			};

			const mockExec = {
				start: vi.fn().mockResolvedValue(mockStream),
				inspect: mockExecInspect,
			};

			mockContainer.exec.mockResolvedValue(mockExec);

			const sandbox = await createSandbox();
			const result = await sandbox.execute('print("Hello, World!")');

			expect(mockContainer.exec).toHaveBeenCalledWith(
				expect.objectContaining({
					Cmd: ["python3", "-c", 'print("Hello, World!")'],
					AttachStdout: true,
					AttachStderr: true,
				}),
			);
			expect(result.exitCode).toBe(0);
			expect(mockDemuxStream).toHaveBeenCalledWith(
				mockStream,
				expect.any(Object),
				expect.any(Object),
			);
		});

		it("should execute simple JavaScript code", async () => {
			const mockExecInspect = vi.fn().mockResolvedValue({
				ExitCode: 0,
				Running: false,
			});

			const mockStream = {
				once: vi.fn().mockImplementation((event: string, handler: unknown) => {
					if (event === "end") {
						setTimeout(() => (handler as () => void)(), 0);
					}
					return mockStream;
				}),
			};

			const mockExec = {
				start: vi.fn().mockResolvedValue(mockStream),
				inspect: mockExecInspect,
			};

			mockContainer.exec.mockResolvedValue(mockExec);

			const sandbox = await createSandbox("javascript");
			const result = await sandbox.execute('console.log("Hello from Node")');

			expect(mockContainer.exec).toHaveBeenCalledWith(
				expect.objectContaining({
					Cmd: ["node", "-e", 'console.log("Hello from Node")'],
					AttachStdout: true,
					AttachStderr: true,
				}),
			);
			expect(result.exitCode).toBe(0);
		});

		it("waits for exec inspection to report completion before resolving", async () => {
			const mockExecInspect = vi
				.fn()
				.mockResolvedValueOnce({
					ExitCode: null,
					Running: true,
				})
				.mockResolvedValueOnce({
					ExitCode: 0,
					Running: false,
				});

			const mockStream = {
				once: vi.fn().mockImplementation((event: string, handler: unknown) => {
					if (event === "end") {
						setTimeout(() => (handler as () => void)(), 0);
					}
					return mockStream;
				}),
			};

			const mockExec = {
				start: vi.fn().mockResolvedValue(mockStream),
				inspect: mockExecInspect,
			};

			mockContainer.exec.mockResolvedValue(mockExec);

			const sandbox = await createSandbox();
			const result = await sandbox.execute('print("Hello, World!")');

			expect(result.exitCode).toBe(0);
			expect(mockExecInspect).toHaveBeenCalledTimes(2);
		});

		it("does not treat a null exit code as completed exec state", async () => {
			const mockExecInspect = vi
				.fn()
				.mockResolvedValueOnce({
					ID: "exec-1",
					ContainerID: "container-1",
					ExitCode: null,
					Running: false,
				})
				.mockResolvedValueOnce({
					ID: "exec-1",
					ContainerID: "container-1",
					ExitCode: 0,
					Running: false,
				});

			const mockStream = {
				once: vi.fn().mockImplementation((event: string, handler: unknown) => {
					if (event === "end") {
						setTimeout(() => (handler as () => void)(), 0);
					}
					return mockStream;
				}),
			};

			const mockExec = {
				start: vi.fn().mockResolvedValue(mockStream),
				inspect: mockExecInspect,
			};

			mockContainer.exec.mockResolvedValue(mockExec);

			const sandbox = await createSandbox();
			const result = await sandbox.execute('print("Hello, World!")');

			expect(result.exitCode).toBe(0);
			expect(mockExecInspect).toHaveBeenCalledTimes(2);
		});

		it("should enforce timeout limit", async () => {
			const _sandbox = await createSandbox();

			// Verify timeout is configured
			const createCall = mockDocker.createContainer.mock.calls[0][0];
			expect(createCall.StopTimeout).toBe(90); // 90 seconds
		});
	});

	describe("destroySandbox", () => {
		it("should kill and remove container", async () => {
			const mockContainerInstance = {
				kill: vi.fn().mockResolvedValue(undefined),
				remove: vi.fn().mockResolvedValue(undefined),
			};

			await destroySandbox(mockContainerInstance as unknown as Container);

			expect(mockContainerInstance.kill).toHaveBeenCalledWith({
				signal: "SIGKILL",
			});
			expect(mockContainerInstance.remove).toHaveBeenCalled();
		});

		it("should handle already stopped containers gracefully", async () => {
			const mockContainerInstance = {
				kill: vi.fn().mockRejectedValue(new Error("Container already stopped")),
				remove: vi.fn().mockResolvedValue(undefined),
			};

			// Should not throw
			await expect(
				destroySandbox(mockContainerInstance as unknown as Container),
			).resolves.not.toThrow();
		});
	});

	describe("sandbox lifecycle", () => {
		it("can create and destroy sandbox", async () => {
			const sandbox = await createSandbox();
			expect(sandbox.container).toBeDefined();

			await sandbox.destroy();
			expect(mockContainer.kill).toHaveBeenCalledWith({ signal: "SIGKILL" });
			expect(mockContainer.remove).toHaveBeenCalled();
		});
	});
});
