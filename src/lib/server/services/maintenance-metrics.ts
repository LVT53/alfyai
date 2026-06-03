export interface MaintenanceStepMetrics {
    stepName: string;
    lastRunAt: number | null;
    lastDurationMs: number | null;
    totalRuns: number;
    totalSuccesses: number;
    totalFailures: number;
    lastError: string | null;
    totalRowsAffected: number;
}

export interface MaintenanceMetrics {
    userId: string;
    steps: Record<string, MaintenanceStepMetrics>;
}

function createEmptyStepMetrics(stepName: string): MaintenanceStepMetrics {
    return {
        stepName,
        lastRunAt: null,
        lastDurationMs: null,
        totalRuns: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        lastError: null,
        totalRowsAffected: 0
    };
}

const metricsStore = new Map<string, MaintenanceMetrics>();

export function getOrCreateMetrics(userId: string): MaintenanceMetrics {
    let metrics = metricsStore.get(userId);
    if (!metrics) {
        metrics = { userId, steps: {} };
        metricsStore.set(userId, metrics);
    }
    return metrics;
}

export function recordStepStart(userId: string, stepName: string): number {
    const metrics = getOrCreateMetrics(userId);
    let step = metrics.steps[stepName];
    if (!step) {
        step = createEmptyStepMetrics(stepName);
        metrics.steps[stepName] = step;
    }
    step.totalRuns++;
    return Date.now();
}

export function recordStepSuccess(
    userId: string,
    stepName: string,
    startTime: number,
    rowsAffected?: number
): void {
    const metrics = getOrCreateMetrics(userId);
    let step = metrics.steps[stepName];
    if (!step) {
        step = createEmptyStepMetrics(stepName);
        metrics.steps[stepName] = step;
        step.totalRuns++;
    }

    const now = Date.now();
    step.lastRunAt = now;
    step.lastDurationMs = now - startTime;
    step.totalSuccesses++;
    if (rowsAffected !== undefined) {
        step.totalRowsAffected += rowsAffected;
    }
}

export function recordStepFailure(
    userId: string,
    stepName: string,
    startTime: number,
    error: unknown
): void {
    const metrics = getOrCreateMetrics(userId);
    let step = metrics.steps[stepName];
    if (!step) {
        step = createEmptyStepMetrics(stepName);
        metrics.steps[stepName] = step;
        step.totalRuns++;
    }

    const now = Date.now();
    step.lastRunAt = now;
    step.lastDurationMs = now - startTime;
    step.totalFailures++;
    step.lastError = error instanceof Error ? error.toString() : String(error);
}

export function getAllMetrics(): MaintenanceMetrics[] {
    return Array.from(metricsStore.values());
}

export function getUserMetrics(userId: string): MaintenanceMetrics | null {
    return metricsStore.get(userId) ?? null;
}

export function resetMetrics(): void {
    metricsStore.clear();
}
