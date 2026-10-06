import { v } from "convex/values";

/**
 * What a Builder or Repair profile lets the backend approve on the owner's behalf: nothing
 * ("ask", the default), low-risk commands, or low- and medium-risk commands. High and
 * critical requests, file changes and tool confirmations always wait for a human. The
 * policy is a structured profile setting enforced here, never prompt text.
 */
export const APPROVAL_POLICIES = ["ask", "auto_low", "auto_low_medium"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];
export const approvalPolicy = v.union(
  v.literal("ask"),
  v.literal("auto_low"),
  v.literal("auto_low_medium"),
);

export function autoApproves(
  policy: ApprovalPolicy | undefined,
  kind: string,
  risk: "low" | "medium" | "high" | "critical",
): boolean {
  if (kind !== "command" || !policy || policy === "ask") return false;
  return risk === "low" || (risk === "medium" && policy === "auto_low_medium");
}
