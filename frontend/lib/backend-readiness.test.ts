import { describe, expect, it, vi } from "vitest";
import { warmBackend } from "./backend-readiness";

const ready = () =>
  new Response(JSON.stringify({ status: "ready", checks: { api: "ok" } }));
const options = () => ({
  signal: new AbortController().signal,
  delayMs: 0,
  timeoutMs: 100,
});

describe("backend readiness", () => {
  it("accepts a ready API and disables caching", async () => {
    const fetcher = vi.fn().mockResolvedValue(ready());
    expect(
      await warmBackend("http://localhost:8000/", { ...options(), fetcher }),
    ).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe("http://localhost:8000/health/ready");
    expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
  });

  it("retries a sleeping or unavailable backend", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("starting", { status: 503 }))
      .mockResolvedValueOnce(ready());
    expect(
      await warmBackend("http://localhost:8000", { ...options(), fetcher }),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops after three network failures", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    expect(
      await warmBackend("http://localhost:8000", { ...options(), fetcher }),
    ).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not mark an unrelated or malformed response as ready", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>Starting</html>"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(null)));
    expect(
      await warmBackend("http://localhost:8000", { ...options(), fetcher }),
    ).toBe(false);
  });

  it("does not start a request after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(
      warmBackend("http://localhost:8000", {
        ...options(),
        signal: controller.signal,
        fetcher,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels an in-flight request without retrying", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        }),
    );
    const result = warmBackend("http://localhost:8000", {
      ...options(),
      signal: controller.signal,
      fetcher,
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds each request with a timeout", async () => {
    const fetcher = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        }),
    );
    expect(
      await warmBackend("http://localhost:8000", {
        ...options(),
        fetcher,
        timeoutMs: 10,
      }),
    ).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("cancels retry backoff without starting another request", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockRejectedValue(new TypeError("offline"));
    const result = warmBackend("http://localhost:8000", {
      ...options(),
      signal: controller.signal,
      fetcher,
      delayMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
