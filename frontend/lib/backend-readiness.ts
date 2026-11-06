export type ReadinessOptions = {
  signal: AbortSignal;
  fetcher?: (
    url: string,
    init: { signal: AbortSignal; cache: "no-store" },
  ) => Promise<Response>;
  delayMs?: number;
  timeoutMs?: number;
};

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** Wakes a sleeping API with at most three health requests. Never calls an LLM. */
export async function warmBackend(
  baseUrl: string,
  {
    signal,
    fetcher = fetch,
    delayMs = 2000,
    timeoutMs = 35000,
  }: ReadinessOptions,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/+$/, "")}/health/ready`;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetcher(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        cache: "no-store",
      });
      if (response.ok) {
        const data = await response.json();
        if (data?.status === "ready" && data?.checks?.api === "ok") return true;
      }
    } catch {
      // An individual timeout/network/JSON failure can be retried; user cancellation cannot.
      signal.throwIfAborted();
    }
    if (attempt < 2) await wait(delayMs * (attempt + 1), signal);
  }
  return false;
}
