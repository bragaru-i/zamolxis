/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as auth from "../auth.js";
import type * as agentProfiles from "../agentProfiles.js";
import type * as pairing from "../pairing.js";
import type * as deviceTokens from "../deviceTokens.js";
import type * as onboarding from "../onboarding.js";
import type * as supervisor from "../supervisor.js";
import type * as approvals from "../approvals.js";
import type * as events from "../events.js";
import type * as integration from "../integration.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_commands from "../lib/commands.js";
import type * as lib_settlement from "../lib/settlement.js";
import type * as lib_value from "../lib/value.js";
import type * as node from "../node.js";
import type * as profiles from "../profiles.js";
import type * as repositories from "../repositories.js";
import type * as runDetail from "../runDetail.js";
import type * as runs from "../runs.js";
import type * as sessions from "../sessions.js";
import type * as tasks from "../tasks.js";
import type * as traces from "../traces.js";
import type * as trust from "../trust.js";
import type * as usage from "../usage.js";
import type * as workspaces from "../workspaces.js";
import type * as workstations from "../workstations.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  admin: typeof admin;
  auth: typeof auth;
  agentProfiles: typeof agentProfiles;
  pairing: typeof pairing;
  deviceTokens: typeof deviceTokens;
  onboarding: typeof onboarding;
  supervisor: typeof supervisor;
  approvals: typeof approvals;
  events: typeof events;
  integration: typeof integration;
  "lib/access": typeof lib_access;
  "lib/commands": typeof lib_commands;
  "lib/settlement": typeof lib_settlement;
  "lib/value": typeof lib_value;
  node: typeof node;
  profiles: typeof profiles;
  repositories: typeof repositories;
  runDetail: typeof runDetail;
  runs: typeof runs;
  sessions: typeof sessions;
  tasks: typeof tasks;
  traces: typeof traces;
  trust: typeof trust;
  usage: typeof usage;
  workspaces: typeof workspaces;
  workstations: typeof workstations;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
