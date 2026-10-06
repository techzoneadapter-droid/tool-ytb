import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";

const clamp = (n: number, max: number) =>
  Math.min(max, Math.max(1, Math.floor(n) || 1));
export function pipelineConcurrency(memory = os.freemem()) {
  return clamp(
    Number(process.env.MAX_PARALLEL_VIDEOS || 8),
    memory < 1024 ** 3 ? 2 : memory < 2 * 1024 ** 3 ? 4 : 12,
  );
}
export function ffmpegConcurrency(
  cpus = os.cpus().length,
  memory = os.freemem(),
) {
  return Math.min(
    clamp(cpus / 2, 4),
    memory < 1024 ** 3 ? 1 : memory < 2 * 1024 ** 3 ? 2 : 4,
  );
}
export function providerConcurrency(provider: string, fallback = 8) {
  return clamp(
    Number(
      process.env[
        `TTS_${provider.replaceAll("-", "_").toUpperCase()}_CONCURRENCY`
      ] ||
        process.env.TTS_API_CONCURRENCY ||
        fallback,
    ),
    32,
  );
}
export class ResourceLimiter {
  active = 0;
  peak = 0;
  private waiters: (() => void)[] = [];
  async acquire(
    limit: number | (() => number),
    onWait?: () => void,
    units = 1,
  ) {
    let reported = false;
    while (
      this.active + units >
      (typeof limit === "function" ? limit() : limit)
    ) {
      if (!reported) {
        reported = true;
        onWait?.();
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += units;
    this.peak = Math.max(this.peak, this.active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= units;
      for (const wake of this.waiters.splice(0)) wake();
    };
  }
}
const gates = new Map<string, ResourceLimiter>();
export function resourceGate(name: string) {
  let gate = gates.get(name);
  if (!gate) {
    gate = new ResourceLimiter();
    gates.set(name, gate);
  }
  return gate;
}
const context = new AsyncLocalStorage<{
  onWait?: (resource: string) => void;
  onAcquired?: (resource: string) => void;
}>();
export function withResourceContext<T>(
  value: NonNullable<ReturnType<typeof context.getStore>>,
  action: () => Promise<T>,
) {
  return context.run(value, action);
}
export async function withResource<T>(
  name: string,
  limit: number | (() => number),
  action: () => Promise<T>,
  units = 1,
) {
  const callbacks = context.getStore();
  const release = await resourceGate(name).acquire(
    limit,
    () => callbacks?.onWait?.(name),
    units,
  );
  try {
    callbacks?.onAcquired?.(name);
    return await action();
  } finally {
    release();
  }
}
