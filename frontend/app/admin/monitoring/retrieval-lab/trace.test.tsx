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

it("shows that ingestion belongs to the indexed context and exposes review evidence", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          trace: {
            searches: [],
            citations: [],
            context: [
              {
                id: "chunk",
                kind: "document",
                title: "Indexed report",
                index_id: "reviewed-index",
              },
            ],
          },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          metadata: { format: "pdf" },
          approved_at: "2026-11-14T08:00:00Z",
          chunks: 5,
          model: "test",
          hash: "approved-hash",
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  render(
    <RetrievalTrace id="run" question="Question" summary="Complete" traced />,
  );
  const run = screen.getByText("Question").closest("details")!;
  run.open = true;
  fireEvent(run, new Event("toggle"));
  fireEvent.click(await screen.findByRole("button", { name: "Admin Review" }));
  const row = screen.getByText(/Indexed report/).closest("details")!;
  fireEvent.click(within(row).getByText(/Indexed report/));
  expect(
    await screen.findByText("Approved snapshot: approved-hash"),
  ).toBeTruthy();
  expect(fetcher.mock.calls[1][0]).toContain("/indexes/reviewed-index");
});

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
  fireEvent.click(await screen.findByRole("button", { name: "Hybrid Search" }));
  const candidate = within(run).getByText("#1 · chunk-1").closest("details")!;
  candidate.open = true;
  fireEvent(candidate, new Event("toggle"));
  expect(await within(candidate).findByText("Verified evidence.")).toBeTruthy();
  expect(within(candidate).getByRole("link").getAttribute("href")).toContain(
    "version_id=v2",
  );
});
