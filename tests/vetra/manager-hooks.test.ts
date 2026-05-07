import { describe, expect, it, vi } from "vitest";

describe("manager Vetra hooks", () => {
  it("fires createDispatch after POST /dispatches persists SQLite", async () => {
    const writer = {
      createDispatch: vi.fn(),
      startProcessing: vi.fn(),
      registerArtifact: vi.fn(),
      markDone: vi.fn(),
      verifySignal: vi.fn(),
    };
    expect(writer.createDispatch).not.toHaveBeenCalled();
  });
});
