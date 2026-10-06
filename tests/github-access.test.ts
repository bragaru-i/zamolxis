import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

// Per-repository GitHub publishing access as a computer reports it: status only, owner-isolated.
const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./node.ts": () => import("../convex/node"),
  "./onboarding.ts": () => import("../convex/onboarding"),
  "./repositories.ts": () => import("../convex/repositories"),
  "./workstations.ts": () => import("../convex/workstations"),
};

async function fixture() {
  const t = convexTest(schema, modules);
  const { user } = await seedHuman(t, "alice");
  const { user: other } = await seedHuman(t, "bob");
  const nodeFor = (subject: string, owner: string) =>
    t.withIdentity({
      subject,
      issuer: "https://identity.example",
      tokenIdentifier: subject,
      ownerSubject: owner,
    });
  const workstationId = await user.mutation(api.workstations.register, {
    name: "Studio",
    nodeAuthSubject: "device",
  });
  const otherWorkstationId = await other.mutation(api.workstations.register, {
    name: "Bob's computer",
    nodeAuthSubject: "bob-device",
  });
  const node = nodeFor("device", "alice");
  const otherNode = nodeFor("bob-device", "bob");
  const [registered] = await node.mutation(api.onboarding.registerRepositories, {
    workstationId,
    repositories: [{ name: "zamolxis", remoteUrl: "https://github.com/bragaru-i/zamolxis.git" }],
  });
  if (!registered) throw new Error("not registered");
  await node.mutation(api.node.registerLocation, {
    workstationId,
    repositoryId: registered.repositoryId,
    canonicalPath: "/Users/me/zamolxis",
    gitCommonDir: "/Users/me/zamolxis/.git",
    headSha: "base",
  });
  const list = () => user.query(api.repositories.listLocations, { workstationId });
  return {
    t,
    user,
    other,
    node,
    otherNode,
    nodeFor,
    workstationId,
    otherWorkstationId,
    repositoryId: registered.repositoryId,
    list,
  };
}

describe("GitHub publishing access per repository", () => {
  it("stores what the computer reports and shows it with the token creation link", async () => {
    const f = await fixture();
    const [before] = await f.list();
    expect(before?.githubAccess).toBeUndefined();
    expect(before?.github?.slug).toBe("bragaru-i/zamolxis");
    const link = new URL(before?.github?.tokenUrl ?? "");
    expect(link.host).toBe("github.com");
    expect(link.searchParams.get("target_name")).toBe("bragaru-i");
    const checkedAt = Date.now() - 1000;
    const expiresAt = Date.now() + 80 * 24 * 60 * 60 * 1000;
    await f.node.mutation(api.node.reportGithubAccess, {
      workstationId: f.workstationId,
      repositoryId: f.repositoryId,
      access: { status: "ok", login: "bragaru-i", expiresAt, checkedAt },
    });
    expect((await f.list())[0]?.githubAccess).toEqual({
      status: "ok",
      login: "bragaru-i",
      expiresAt,
      checkedAt,
    });
    // An older check (delivered late) never replaces a newer one.
    await f.node.mutation(api.node.reportGithubAccess, {
      workstationId: f.workstationId,
      repositoryId: f.repositoryId,
      access: { status: "missing", checkedAt: checkedAt - 60_000 },
    });
    expect((await f.list())[0]?.githubAccess?.status).toBe("ok");
    await f.node.mutation(api.node.reportGithubAccess, {
      workstationId: f.workstationId,
      repositoryId: f.repositoryId,
      access: { status: "missing", checkedAt: Date.now() },
    });
    expect((await f.list())[0]?.githubAccess).toMatchObject({ status: "missing" });
    expect((await f.list())[0]?.githubAccess?.login).toBeUndefined();
  });

  it("accepts only bounded status fields, never a token", async () => {
    const f = await fixture();
    const report = (access: Record<string, unknown>) =>
      f.node.mutation(api.node.reportGithubAccess, {
        workstationId: f.workstationId,
        repositoryId: f.repositoryId,
        access: access as never,
      });
    await expect(
      report({ status: "ok", checkedAt: Date.now(), token: "github_pat_x" }),
    ).rejects.toThrow();
    await expect(report({ status: "admin", checkedAt: Date.now() })).rejects.toThrow();
    await expect(
      report({ status: "ok", login: "not a login!", checkedAt: Date.now() }),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await expect(
      report({ status: "ok", expiresAt: Date.now() + 10_000 * 24 * 60 * 60 * 1000, checkedAt: 1 }),
    ).rejects.toThrow("INVALID_ARGUMENT");
    // A check from the future is recorded as now.
    await report({ status: "ok", checkedAt: Date.now() + 60 * 60 * 1000 });
    expect((await f.list())[0]?.githubAccess?.checkedAt).toBeLessThanOrEqual(Date.now());
  });

  it("is reported only by the owner's own computer and shown only to the owner", async () => {
    const f = await fixture();
    const access = { status: "ok" as const, checkedAt: Date.now() };
    await expect(
      f.otherNode.mutation(api.node.reportGithubAccess, {
        workstationId: f.otherWorkstationId,
        repositoryId: f.repositoryId,
        access,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      f.nodeFor("intruder", "alice").mutation(api.node.reportGithubAccess, {
        workstationId: f.workstationId,
        repositoryId: f.repositoryId,
        access,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      f.other.query(api.repositories.listLocations, { workstationId: f.workstationId }),
    ).rejects.toThrow("FORBIDDEN");
  });
});
