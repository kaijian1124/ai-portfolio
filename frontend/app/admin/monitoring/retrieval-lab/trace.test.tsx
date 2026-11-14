// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RetrievalTrace } from "./trace";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("opens a single question, shows ranked candidates, and loads the chosen chunk", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          trace: {
            route: "rag",
            model: "test",
            context: [],
            citations: [],
            searches: [
              {
                query: "Example question",
                scope: null,
                latency_ms: 20,
                vector: [{ id: "chunk-1", rank: 1 }],
                keyword: [],
                fused: [],
                kept: [],
              },
            ],
          },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "Example report",
          document_id: "doc",
          version_id: "v2",
          index_id: "index",
          ordinal: 1,
          page: 8,
          heading: "Sources",
          table_header: null,
          text: "Verified evidence.",
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  render(
    <RetrievalTrace
      id="run"
      question="Example question"
      summary="20 ms"
      traced
    />,
  );
  const run = screen.getByText("Example question").closest("details")!;
  expect(fetcher).not.toHaveBeenCalled();
  run.open = true;
  fireEvent(run, new Event("toggle"));
  fireEvent.click(await screen.findByRole("button", { name: "Vector" }));
  const candidate = within(run).getByText("#1 · chunk-1").closest("details")!;
  candidate.open = true;
  fireEvent(candidate, new Event("toggle"));
  expect(await within(candidate).findByText("Verified evidence.")).toBeTruthy();
  expect(within(candidate).getByRole("link").getAttribute("href")).toContain(
    "version_id=v2",
  );
});
