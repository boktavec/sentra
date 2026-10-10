// ponytail: in-process counters in Prometheus text format; SENTRA-23 replaces this with the real metrics stack.
const counters = new Map<string, number>();
const gauges = new Map<string, number>();

const labelled = (name: string, labels: Record<string, string>) =>
  `${name}${Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(",")
    .replace(/^(.+)$/, "{$1}")}`;

export function inc(name: string, labels: Record<string, string> = {}): void {
  const key = labelled(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

/** A duration or size: exposes `<name>_sum` and `<name>_count`, enough for averages until real histograms arrive. */
export function observe(name: string, labels: Record<string, string>, value: number): void {
  for (const [suffix, amount] of [
    ["_sum", value],
    ["_count", 1],
  ] as const) {
    const key = labelled(name + suffix, labels);
    counters.set(key, (counters.get(key) ?? 0) + amount);
  }
}

/** A value that goes up and down (queue depth), set by whoever owns it. */
export function setGauge(name: string, value: number): void {
  gauges.set(name, value);
}

export function render(): string {
  return [...counters, ...gauges].map(([key, value]) => `${key} ${value}`).join("\n") + "\n";
}
