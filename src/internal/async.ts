/** Merge two abort signals into one (uses AbortSignal.any when available). */
export function combineSignals(primary: AbortSignal, extra?: AbortSignal): AbortSignal {
  if (!extra) {
    return primary;
  }
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') {
    return anyFn([primary, extra]);
  }
  const controller = new AbortController();
  const forward = (s: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(s.reason);
    }
  };
  for (const s of [primary, extra]) {
    if (s.aborted) {
      forward(s);
      break;
    }
    s.addEventListener('abort', () => forward(s), { once: true });
  }
  return controller.signal;
}

/** Resolve after `ms`, or early (without rejecting) if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
