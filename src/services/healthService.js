const healthState = {
  apiFailures: 0,
  orderFailures: 0,
  orderRetries: 0,
  latencyMs: [],
  lastError: null,
  lastUpdatedAt: new Date().toISOString(),
};

function markUpdate() {
  healthState.lastUpdatedAt = new Date().toISOString();
}

export function recordApiFailure(message) {
  healthState.apiFailures += 1;
  healthState.lastError = message;
  markUpdate();
}

export function recordOrderFailure(message) {
  healthState.orderFailures += 1;
  healthState.lastError = message;
  markUpdate();
}

export function recordOrderRetry() {
  healthState.orderRetries += 1;
  markUpdate();
}

export function recordLatency(ms) {
  if (Number.isFinite(ms)) {
    healthState.latencyMs.push(ms);
    if (healthState.latencyMs.length > 200) {
      healthState.latencyMs.shift();
    }
  }
  markUpdate();
}

export function getHealthSnapshot() {
  const latencies = healthState.latencyMs;
  const avgLatencyMs = latencies.length > 0
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    : 0;
  const maxLatencyMs = latencies.length > 0 ? Math.max(...latencies) : 0;

  return {
    apiFailures: healthState.apiFailures,
    orderFailures: healthState.orderFailures,
    orderRetries: healthState.orderRetries,
    avgLatencyMs,
    maxLatencyMs,
    lastError: healthState.lastError,
    lastUpdatedAt: healthState.lastUpdatedAt,
  };
}
