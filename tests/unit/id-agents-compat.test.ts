// T-DEPLOY.6 — the `id-agents-compat` suite: guards the manager↔Kapelle-console
// API contract so a renamed/removed manager route is caught by a red test before
// it deploys and silently breaks the /ops console (incident I-4 drift class).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractRegisteredRoutes,
  normalizeRoutePath,
  findMissingContractRoutes,
  CONSOLE_CONTRACT_ROUTES,
  MANAGER_ROUTE_SOURCE_FILES,
  type ConsoleContractRoute,
  type RouteSig,
} from "../../src/compat/console-contract.js";

const ROOT = join(__dirname, "..", "..");

describe("extractRegisteredRoutes (pure)", () => {
  it("extracts method+path from varied registration styles", () => {
    const src = `
      this.managementApp.get('/agents', async (req, res) => {});
      app.post("/tasks", handler);
      router.patch(\`/agents/:name/catalog\`, handler);
      something.delete('/agents/:id', h);
      app.get('/usage/daily-report', h);
    `;
    expect(extractRegisteredRoutes(src)).toEqual<RouteSig[]>([
      { method: "get", path: "/agents" },
      { method: "post", path: "/tasks" },
      { method: "patch", path: "/agents/:name/catalog" },
      { method: "delete", path: "/agents/:id" },
      { method: "get", path: "/usage/daily-report" },
    ]);
  });

  it("ignores non-route method calls and dynamic (non-literal) paths", () => {
    const src = `
      arr.get(0); obj.post(payload);
      app.get(routeVar, h);          // dynamic path — not capturable
      app.get('relative/no-slash', h); // not a leading-slash route
      app.get('/health', h);
    `;
    expect(extractRegisteredRoutes(src)).toEqual<RouteSig[]>([{ method: "get", path: "/health" }]);
  });
});

describe("normalizeRoutePath (pure)", () => {
  it("collapses :params so differently-named params match", () => {
    expect(normalizeRoutePath("/agents/:name/detail")).toBe("/agents/:x/detail");
    expect(normalizeRoutePath("/agents/:agent/detail")).toBe("/agents/:x/detail");
  });
  it("strips a query string and trailing slash (but keeps root)", () => {
    expect(normalizeRoutePath("/tasks?team=default")).toBe("/tasks");
    expect(normalizeRoutePath("/agents/")).toBe("/agents");
    expect(normalizeRoutePath("/")).toBe("/");
  });
});

describe("findMissingContractRoutes (pure)", () => {
  const contract: ConsoleContractRoute[] = [
    { method: "get", path: "/agents", consumer: "x" },
    { method: "get", path: "/agents/:name/detail", consumer: "y" },
    { method: "get", path: "/tasks", consumer: "z" },
  ];

  it("returns [] when every contract route is registered (param name may differ)", () => {
    const registered: RouteSig[] = [
      { method: "get", path: "/agents" },
      { method: "get", path: "/agents/:agent/detail" }, // differently-named param
      { method: "get", path: "/tasks" },
      { method: "post", path: "/tasks" }, // extra/additive — fine
    ];
    expect(findMissingContractRoutes(registered, contract)).toEqual([]);
  });

  it("flags a contract route that was removed", () => {
    const registered: RouteSig[] = [
      { method: "get", path: "/agents" },
      { method: "get", path: "/tasks" },
    ];
    const missing = findMissingContractRoutes(registered, contract);
    expect(missing.map((m) => m.path)).toEqual(["/agents/:name/detail"]);
  });

  it("flags a method mismatch (GET contract vs only POST registered)", () => {
    const registered: RouteSig[] = [{ method: "post", path: "/tasks" }];
    const missing = findMissingContractRoutes(registered, [{ method: "get", path: "/tasks", consumer: "z" }]);
    expect(missing).toHaveLength(1);
  });
});

describe("manifest integrity", () => {
  it("has no duplicate (method, path) entries", () => {
    const keys = CONSOLE_CONTRACT_ROUTES.map((r) => `${r.method} ${normalizeRoutePath(r.path)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("every entry documents its console consumer", () => {
    for (const r of CONSOLE_CONTRACT_ROUTES) expect(r.consumer.length).toBeGreaterThan(0);
  });
});

// The actual drift guard: scan the live manager source and assert every route
// the Kapelle console consumes is still registered. This is what fails the build
// when someone renames/removes a console-facing route.
describe("manager ↔ console route parity (live source)", () => {
  function collectRegisteredRoutes(): RouteSig[] {
    const all: RouteSig[] = [];
    for (const rel of MANAGER_ROUTE_SOURCE_FILES) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, rel), "utf8");
      } catch {
        continue;
      }
      all.push(...extractRegisteredRoutes(text));
    }
    return all;
  }

  it("source files in the manifest exist and register routes", () => {
    const registered = collectRegisteredRoutes();
    expect(registered.length).toBeGreaterThan(20);
  });

  it("every console-contract route is still registered in the manager", () => {
    const registered = collectRegisteredRoutes();
    const missing = findMissingContractRoutes(registered);
    if (missing.length > 0) {
      const msg = missing.map((m) => `  ${m.method.toUpperCase()} ${m.path}  (consumed by ${m.consumer})`).join("\n");
      throw new Error(
        `id-agents↔Kapelle drift: console-contract route(s) no longer registered in the manager.\n` +
          `Restore the route, or update CONSOLE_CONTRACT_ROUTES + the kapelle-site adapter together:\n${msg}`,
      );
    }
    expect(missing).toEqual([]);
  });
});
