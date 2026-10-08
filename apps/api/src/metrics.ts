// ponytail: in-process counters in Prometheus text format; SENTRA-23 replaces this with the real metrics stack.
const counters = new Map<string, number>();
const gauges = new Map<string, number>();

export function inc(name: string, labels: Record<string, string> = {}): void {
  const key = `${name}${Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(",")
    .replace(/^(.+)$/, "{$1}")}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

/** A value that goes up and down (queue depth), set by whoever owns it. */
export function setGauge(name: string, value: number): void {
  gauges.set(name, value);
}

export function render(): string {
  return [...counters, ...gauges].map(([key, value]) => `${key} ${value}`).join("\n") + "\n";
}
