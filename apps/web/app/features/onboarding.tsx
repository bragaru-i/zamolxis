"use client";
import { Button, Card, Timeline, TimelineItem, type Tone } from "@zamolxis/ui";
import { useQuery } from "convex/react";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import { useNow } from "./workspace";

// Onboarding checklist (#45): from sign-in to the first session, each step as the backend
// sees it (onboarding.progress). Shown until the first session exists or it is hidden.

export type OnboardingState = "done" | "in_progress" | "needs_you" | "failed" | "upcoming";
export interface OnboardingStep {
  id: string;
  title: string;
  state: OnboardingState;
  detail: string;
  staleAfter?: number;
  stale?: { state: OnboardingState; detail: string };
}
export interface OnboardingProgress {
  complete: boolean;
  steps: OnboardingStep[];
}

const STATE: Record<OnboardingState, { label: string; tone: Tone }> = {
  done: { label: "Done", tone: "success" },
  in_progress: { label: "In progress", tone: "info" },
  needs_you: { label: "Needs you", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  upcoming: { label: "Not yet", tone: "neutral" },
};
export const DISMISS_KEY = "zamolxis.onboarding.hidden";

/**
 * Steps as they apply now: a step reported while the computer was online turns into its stale
 * state once the computer has not reported for too long (a query result does not age by itself).
 */
export function currentSteps(progress: OnboardingProgress, now: number): OnboardingStep[] {
  return progress.steps.map((step) =>
    step.stale && step.staleAfter !== undefined && now > step.staleAfter
      ? { ...step, state: step.stale.state, detail: step.stale.detail }
      : step,
  );
}

/** Detail text with `command` spans rendered as code. */
export function detailText(text: string): ReactNode[] {
  return text.split("`").map((part, index) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and static.
    index % 2 ? <code key={index}>{part}</code> : <span key={index}>{part}</span>,
  );
}

export function OnboardingCard({
  progress,
  now,
  onHide,
}: {
  progress: OnboardingProgress;
  now: number;
  onHide: () => void;
}) {
  const steps = currentSteps(progress, now);
  const done = steps.filter((step) => step.state === "done").length;
  return (
    <Card label="Get started">
      <div className="z-row">
        <h2 className="z-title">Get started</h2>
        <span className="z-spacer" />
        <span className="z-xsmall z-muted">
          {done} of {steps.length} done
        </span>
      </div>
      <Timeline label="Setup steps">
        {steps.map((step) => {
          const state = STATE[step.state] ?? STATE.upcoming;
          return (
            <TimelineItem
              key={step.id}
              tone={state.tone}
              title={step.title}
              meta={<span className={`z-badge z-tone-${state.tone}`}>{state.label}</span>}
            >
              {step.detail ? detailText(step.detail) : undefined}
            </TimelineItem>
          );
        })}
      </Timeline>
      <Button variant="ghost" onClick={onHide}>
        Hide checklist
      </Button>
    </Card>
  );
}

export function OnboardingChecklist({ ready }: { ready: boolean }) {
  const progress = useQuery(api.onboarding.progress, ready ? {} : "skip") as
    | OnboardingProgress
    | undefined;
  const now = useNow(5000);
  // Read after mount: the server render has no storage.
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setHidden(false);
    }
  }, []);
  if (!progress || progress.complete || hidden) return null;
  return (
    <OnboardingCard
      progress={progress}
      now={now}
      onHide={() => {
        setHidden(true);
        try {
          localStorage.setItem(DISMISS_KEY, "1");
        } catch {
          // Private browsing without storage: hidden for this visit only.
        }
      }}
    />
  );
}
