// ponytail: in-process counters in Prometheus text format; SENTRA-23 replaces this with the real metrics stack.
const counters = new Map<string, number>();

export function inc(name: string, labels: Record<string, string> = {}): void {
  const key = `${name}${Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(",")
    .replace(/^(.+)$/, "{$1}")}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function render(): string {
  return [...counters].map(([key, value]) => `${key} ${value}`).join("\n") + "\n";
}

export const get = (key: string): number => counters.get(key) ?? 0;
