import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerServiceWorker } from "./service-worker";

const source = readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8");
const offlinePage = readFileSync(join(__dirname, "..", "public", "offline.html"), "utf8");

type Handler = (event: Record<string, unknown>) => void;

/** Runs public/sw.js against an in-memory worker scope and Cache Storage. */
function worker(network: (request: Request) => Promise<Response>) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  const fetched: string[] = [];
  const caches = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        add: async (request: Request) => {
          fetched.push(new URL(request.url).pathname);
          store.set(new URL(request.url).pathname, new Response("offline page"));
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (url: string) => {
      for (const store of stores.values()) if (store.has(url)) return store.get(url);
      return undefined;
    },
  };
  const self = {
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const BaseRequest = Request;
  class RelativeRequest extends BaseRequest {
    constructor(input: string, init?: RequestInit) {
      super(new URL(input, "https://app.example"), init);
    }
  }
  new Function("self", "caches", "fetch", "Request", "Response", source)(
    self,
    caches,
    network,
    RelativeRequest,
    Response,
  );
  const dispatch = async (type: string, event: Record<string, unknown> = {}) => {
    let waited: Promise<unknown> | undefined;
    let responded: Promise<Response> | undefined;
    handlers.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
      respondWith: (promise: Promise<Response>) => {
        responded = promise;
      },
    });
    await waited;
    return responded;
  };
  return { dispatch, stores, fetched };
}

const navigate = (url: string) => ({ request: { url, mode: "navigate", method: "GET" } });

describe("service worker", () => {
  it("precaches only the offline page and drops older caches", async () => {
    const sw = worker(async () => new Response("page"));
    sw.stores.set("old-cache", new Map([["/api/data", new Response("stale")]]));
    await sw.dispatch("install");
    await sw.dispatch("activate");
    expect(sw.fetched).toEqual(["/offline.html"]);
    expect([...sw.stores.keys()]).toEqual(["zamolxis-offline-v1"]);
    expect([...(sw.stores.get("zamolxis-offline-v1")?.keys() ?? [])]).toEqual(["/offline.html"]);
  });

  it("never handles API or data requests and never stores network responses", async () => {
    const sw = worker(async () => new Response("live page"));
    await sw.dispatch("install");
    for (const request of [
      { url: "https://deployment.convex.cloud/api/query", mode: "cors", method: "POST" },
      { url: "https://app.example/_next/static/app.js", mode: "no-cors", method: "GET" },
      { url: "https://app.example/api/auth", mode: "navigate", method: "POST" },
    ])
      expect(await sw.dispatch("fetch", { request })).toBeUndefined();
    const online = await sw.dispatch("fetch", navigate("https://app.example/?session=1"));
    expect(await online?.text()).toBe("live page");
    expect([...(sw.stores.get("zamolxis-offline-v1")?.keys() ?? [])]).toEqual(["/offline.html"]);
  });

  it("shows the offline page when a page load fails", async () => {
    const sw = worker(async () => {
      throw new TypeError("Failed to fetch");
    });
    await sw.dispatch("install");
    const offline = await sw.dispatch("fetch", navigate("https://app.example/"));
    expect(await offline?.text()).toBe("offline page");
  });

  it("ships a self-contained offline page and a registration that parses as plain script", () => {
    expect(offlinePage).toContain("You're offline");
    expect(offlinePage).not.toMatch(/<(script|link)[^>]+(src|href)=/);
    expect(() => new Function(registerServiceWorker)).not.toThrow();
    expect(registerServiceWorker).toContain('register("/sw.js", { scope: "/" })');
  });
});
