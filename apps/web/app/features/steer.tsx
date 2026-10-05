"use client";
import { Button, Notice } from "@zamolxis/ui";
import { useMutation } from "convex/react";
import { useRef, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { errorCode, explainError } from "./errors";

// Runs that can still take a message from you.
export const STEERABLE = ["running", "waiting", "needs_approval"];

/** A small "Message agent" input on an active run card. */
export function SteerRun({ runId }: { runId: Id<"agentRuns"> }) {
  const send = useMutation(api.runs.sendMessage);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "danger" | "success"; text: string }>();
  // One key per draft: retrying the same draft never sends it twice.
  const key = useRef<string>(undefined);
  if (!open)
    return (
      <div>
        <Button variant="ghost" size="small" onClick={() => setOpen(true)}>
          Message agent
        </Button>
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      </div>
    );
  const submit = async () => {
    if (!text.trim() || busy) return;
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setNotice(undefined);
    try {
      await send({ runId, message: text, idempotencyKey: key.current });
      key.current = undefined;
      setText("");
      setOpen(false);
      setNotice({ tone: "success", text: "Sent to the agent." });
    } catch (error) {
      setNotice({
        tone: "danger",
        text:
          errorCode(error) === "RUNTIME_MESSAGE_UNSUPPORTED"
            ? "The Zamolxis Node on your Mac can't message agents yet. Update it and try again."
            : explainError(error, "Could not send the message. Try again."),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="z-stack"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        className="z-textarea"
        style={{ padding: "8px", resize: "vertical" }}
        aria-label="Message the agent"
        placeholder="Tell the agent what to change…"
        rows={2}
        maxLength={16000}
        value={text}
        disabled={busy}
        onChange={(event) => {
          setText(event.target.value);
          key.current = undefined;
        }}
      />
      <div className="z-row">
        <Button type="submit" size="small" disabled={busy || !text.trim()}>
          {busy ? "Sending…" : "Send"}
        </Button>
        <Button variant="ghost" size="small" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
    </form>
  );
}
