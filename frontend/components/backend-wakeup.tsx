"use client";
import { useEffect } from "react";
import { warmBackend } from "../lib/backend-readiness";
export function BackendWakeup() {
  useEffect(() => {
    const controller = new AbortController();
    const url = process.env.NEXT_PUBLIC_API_BASE_URL;
    if (url)
      void warmBackend(url, { signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, []);
  return null;
}
