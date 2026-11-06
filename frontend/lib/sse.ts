export type ChatEvent = { event: string; data: unknown };
export function parseEvents(buffer: string): {
  events: ChatEvent[];
  rest: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: ChatEvent[] = [];
  for (const block of blocks) {
    if (!block || block.startsWith(":")) continue;
    const event =
      block
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim() ?? "message";
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      events.push({ event, data: JSON.parse(data) });
    } catch {
      events.push({
        event: "error",
        data: { message: "Invalid assistant response." },
      });
    }
  }
  return { events, rest };
}
