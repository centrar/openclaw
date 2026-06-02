import { describe, expect, it } from "vitest";
import { ok, type FileSystem } from "../types.js";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "./jsonl-storage.js";

type JsonlStorageFs = Pick<
  FileSystem,
  "readTextFile" | "readTextLines" | "writeFile" | "appendFile"
>;

function createReadOnlyFs(content: string): JsonlStorageFs {
  return {
    readTextFile: async () => ok(content),
    readTextLines: async (_path, options) => ok(content.split("\n").slice(0, options?.maxLines)),
    writeFile: async () => ok(undefined),
    appendFile: async () => ok(undefined),
  };
}

describe("JsonlSessionStorage timestamps", () => {
  it("rejects invalid session header timestamps", async () => {
    const fs = createReadOnlyFs(
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "not-a-date",
        cwd: "/repo",
      })}\n`,
    );

    await expect(loadJsonlSessionMetadata(fs, "/sessions/invalid.jsonl")).rejects.toThrow(
      "session header has invalid timestamp",
    );
  });

  it("rejects invalid entry timestamps", async () => {
    const fs = createReadOnlyFs(
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/repo",
      })}\n${JSON.stringify({
        type: "custom",
        id: "entry-1",
        parentId: null,
        timestamp: "not-a-date",
        customType: "note",
      })}\n`,
    );

    await expect(JsonlSessionStorage.open(fs, "/sessions/invalid-entry.jsonl")).rejects.toThrow(
      "line 2 has invalid timestamp",
    );
  });

  it("redacts raw NVIDIA keys before appending session JSONL entries", async () => {
    const writes: string[] = [];
    const fs: JsonlStorageFs = {
      readTextFile: async () => ok(writes.join("")),
      readTextLines: async (_path, options) =>
        ok(writes.join("").split("\n").slice(0, options?.maxLines)),
      writeFile: async (_path, content) => {
        writes.push(String(content));
        return ok(undefined);
      },
      appendFile: async (_path, content) => {
        writes.push(String(content));
        return ok(undefined);
      },
    };
    const rawKey = ["nvapi", "session-secret"].join("-");
    const storage = await JsonlSessionStorage.create(fs, "/sessions/redacted.jsonl", {
      cwd: `/repo/${rawKey}`,
      parentSessionPath: `/parent/${rawKey}`,
      sessionId: "session-redact",
    });

    await storage.appendEntry({
      type: "custom",
      id: "entry-redact",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "secret-probe",
      data: {
        [rawKey]: "field name",
        bearer: `Bearer ${rawKey}`,
        value: rawKey,
      },
    });

    const serialized = writes.join("");
    expect(serialized).not.toContain(rawKey);
    expect(serialized).toContain("[REDACTED_NVIDIA_API_KEY]");
    expect(JSON.stringify((await storage.getEntries()).at(-1))).not.toContain(rawKey);
  });
});
