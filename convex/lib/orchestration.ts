// A model may recommend delegation, but only the owner's words authorize it.
// Keep this deliberately conservative: exploratory questions such as "how would
// you fix this?" must stay conversational.
export function explicitlyRequestsWork(text: string) {
  const normalized = text.trim();
  if (normalized.startsWith("{")) return true;
  return (
    /^(?:please\s+)?(?:open|start|create|implement|fix|change|update|add|remove|build|refactor|repair|execute|apply|ship|continue|do)\b/i.test(
      normalized,
    ) ||
    /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:open|start|create|implement|fix|change|update|add|remove|build|refactor|repair|execute|apply|ship|continue|do)\b/i.test(
      normalized,
    ) ||
    /\b(?:do it|go ahead|open this work|start the work)\b/i.test(normalized)
  );
}

export function requestsContinuation(text: string) {
  return /\b(?:continue|do it|go ahead|open this work|resume|carry on)\b/i.test(text);
}
