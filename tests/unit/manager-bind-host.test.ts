// Desktop remote access (2026-06-22) — configurable manager bind host.

import { describe, it, expect } from "vitest";
import { resolveManagerBindHost } from "../../src/manager-bind-host.js";

describe("resolveManagerBindHost", () => {
  it("defaults to loopback 127.0.0.1 with no warning when unset", () => {
    const r = resolveManagerBindHost({});
    expect(r.host).toBe("127.0.0.1");
    expect(r.isLoopback).toBe(true);
    expect(r.warning).toBeNull();
  });

  it("treats localhost / ::1 as loopback (no warning)", () => {
    expect(resolveManagerBindHost({ AGENT_MANAGER_HOST: "localhost" }).isLoopback).toBe(true);
    expect(resolveManagerBindHost({ AGENT_MANAGER_HOST: "::1" }).warning).toBeNull();
  });

  it("binds 0.0.0.0 with a security warning (no-auth API exposed to the network)", () => {
    const r = resolveManagerBindHost({ AGENT_MANAGER_HOST: "0.0.0.0" });
    expect(r.host).toBe("0.0.0.0");
    expect(r.isLoopback).toBe(false);
    expect(r.warning).toMatch(/NO authentication/i);
    expect(r.warning).toMatch(/private network/i);
  });

  it("trims whitespace and falls back to loopback when blank", () => {
    expect(resolveManagerBindHost({ AGENT_MANAGER_HOST: "  " }).host).toBe("127.0.0.1");
    expect(resolveManagerBindHost({ AGENT_MANAGER_HOST: " 0.0.0.0 " }).host).toBe("0.0.0.0");
  });

  it("warns for a specific Tailscale IP bind too", () => {
    const r = resolveManagerBindHost({ AGENT_MANAGER_HOST: "100.91.219.57" });
    expect(r.isLoopback).toBe(false);
    expect(r.warning).toContain("100.91.219.57");
  });
});
