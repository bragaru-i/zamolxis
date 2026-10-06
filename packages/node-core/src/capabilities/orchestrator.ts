import { redactSecrets } from "@zamolxis/runtime-core";
import {
  type ConversationMessage,
  extractObject,
  ownerInstructionsBlock,
  REPLY_LIMIT,
} from "./supervisor";

// The top-level Orchestrator only talks: routing, links and any Session it opens are
// decided by the backend. A proposal stays inert until the owner opens it.
export type OrchestratorDecisionKind = "answer" | "ask" | "propose";
export interface OrchestratorDecision {
  readonly decision: OrchestratorDecisionKind;
  readonly reply: string;
  // What would be done if the owner opens it; present only for "propose".
  readonly proposal?: string;
}
export const PROPOSAL_LIMIT = 4000;
const DECISIONS: readonly OrchestratorDecisionKind[] = ["answer", "ask", "propose"];

export function orchestratorInstruction(input: {
  readonly text: string;
  readonly conversation: readonly ConversationMessage[];
  // Deterministic control-plane summary written by the backend.
  readonly context: string;
  readonly instructions?: string;
}): string {
  const conversation = input.conversation.length
    ? input.conversation
        .map((message) => `${message.role === "user" ? "User" : "Zamolxis"}: ${message.text}`)
        .join("\n\n")
    : "(no earlier messages)";
  return [
    "You are the Zamolxis Orchestrator: the owner's top-level assistant above Work Sessions. You only talk. You have no repository and no tools to change anything; do not run commands or read files. Work happens only in Work Sessions, which the owner opens explicitly.",
    "",
    "Current control-plane state (authoritative; do not invent work, links or numbers that are not in it):",
    input.context,
    "",
    ...ownerInstructionsBlock(input.instructions),
    "Earlier conversation:",
    conversation,
    "",
    "The owner's new message:",
    input.text,
    "",
    "Decide how to respond:",
    '- "answer": questions, status, explanations and advice. Answer in "reply" using the state above.',
    '- "ask": the message is ambiguous. Ask one clarifying question in "reply".',
    '- "propose": the owner describes work that could be done but did not explicitly ask to start it. Explain in "reply" and put a precise, self-contained description of the work in "proposal" (goal, scope, acceptance criteria). Nothing starts until the owner opens it.',
    "",
    "Output contract: reply with ONE JSON object and nothing else (optionally inside a ```json fence):",
    '{"decision":"answer"|"ask"|"propose","reply":"<markdown for the owner>","proposal":"<only for propose>"}',
  ].join("\n");
}

function bounded(text: string, limit = REPLY_LIMIT): string {
  return redactSecrets(text).trim().slice(0, limit);
}

// Anything unusable becomes an answer; an incomplete proposal is never offered.
export function parseOrchestratorDecision(raw: string | undefined): OrchestratorDecision {
  const text = raw?.trim() ?? "";
  const parsed = text ? extractObject(text) : undefined;
  const reply = parsed && typeof parsed.reply === "string" ? bounded(parsed.reply) : "";
  const answer = (): OrchestratorDecision => ({
    decision: "answer",
    reply: reply || bounded(parsed ? "" : text) || "The Orchestrator finished without a reply.",
  });
  if (!parsed || !DECISIONS.includes(parsed.decision as OrchestratorDecisionKind) || !reply)
    return answer();
  const decision = parsed.decision as OrchestratorDecisionKind;
  if (decision !== "propose") return { decision, reply };
  const proposal =
    typeof parsed.proposal === "string" ? bounded(parsed.proposal, PROPOSAL_LIMIT) : "";
  return proposal ? { decision, reply, proposal } : answer();
}
