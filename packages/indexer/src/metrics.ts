/** Prometheus text-format counters/gauges, no client library. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  inc(name: string, value = 1, labels: Record<string, string> = {}): void {
    const key = withLabels(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  setGauge(
    name: string,
    value: number,
    labels: Record<string, string> = {},
  ): void {
    this.gauges.set(withLabels(name, labels), value);
  }

  value(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(withLabels(name, labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    for (const [key, value] of this.gauges) lines.push(`${key} ${value}`);
    return `${lines.join("\n")}\n`;
  }
}

const withLabels = (name: string, labels: Record<string, string>): string => {
  const entries = Object.entries(labels);
  if (entries.length === 0) return name;
  const rendered = entries
    .map(([key, value]) => `${key}="${value.replace(/"/g, '\\"')}"`)
    .join(",");
  return `${name}{${rendered}}`;
};

export const METRIC_NAMES = {
  eventsProcessed: "hexvault_indexer_events_processed_total",
  decodeFailures: "hexvault_indexer_decode_failures_total",
  batchesApplied: "hexvault_indexer_batches_applied_total",
  reconciliationOk: "hexvault_indexer_reconciliation_ok_total",
  reconciliationFailed: "hexvault_indexer_reconciliation_failed_total",
  cursorAgeSeconds: "hexvault_indexer_cursor_age_seconds",
} as const;
