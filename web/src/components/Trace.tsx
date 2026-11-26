import { Ban, Check, ChevronUp, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Rise } from "@/components/motion";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Spinner } from "@/components/ui/spinner";
import { Trace as TraceList, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import type { TraceStep } from "@/lib/live";
import { cn } from "@/lib/utils";

const EMPTY = "Every step the server takes shows up here as it happens.";

function StepIcon({ status }: { status: TraceStep["status"] }) {
  if (status === "running") return <Spinner />;
  if (status === "blocked") return <Ban />;
  if (status === "info") return <Info />;
  return <Check className="text-primary dark:text-link" />;
}

/** The server's steps, one line each. A line opens to show its detail. */
export function Steps({ steps, empty = EMPTY, expanded = false }: { steps: TraceStep[]; empty?: string; expanded?: boolean }) {
  if (!steps.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <TraceList>
      {steps.map((step) => (
        <Rise key={step.id}>
          <TraceCollapsible defaultOpen={expanded || step.status === "blocked"}>
            <TraceCollapsibleTrigger className="items-start">
              <TraceLine className="items-start" status={step.status === "blocked" ? "error" : step.status === "running" ? "running" : undefined}>
                <TraceIcon className="mt-0.5">
                  <StepIcon status={step.status} />
                </TraceIcon>
                <TraceTitle className="overflow-visible text-foreground whitespace-normal">
                  {step.label}
                  {step.status === "blocked" && <span className="sr-only"> (blocked)</span>}
                </TraceTitle>
                {step.ms >= 5 && <TraceDescription className="mt-0.5 text-xs">{step.ms} ms</TraceDescription>}
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent className="text-sm">{step.detail}</TraceCollapsibleContent>
          </TraceCollapsible>
        </Rise>
      ))}
    </TraceList>
  );
}

function Status({ live }: { live?: boolean }) {
  if (live === undefined) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", live ? "bg-emerald-500" : "bg-muted-foreground/50")} aria-hidden="true" />
      {live ? "Live" : "After each answer"}
    </span>
  );
}

interface CardProps {
  steps: TraceStep[];
  live?: boolean;
  empty?: string;
  className?: string;
  title?: ReactNode;
  description?: string;
  /** Show every step's detail from the start. */
  expanded?: boolean;
}

/** The trace as a card, for a column of its own. */
export function TraceCard({ steps, live, empty, className, title = "Under the hood", description, expanded }: CardProps) {
  return (
    <Card aria-label="Under the hood" className={cn("text-left", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {live !== undefined && (
          <CardAction>
            <Status live={live} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <Steps steps={steps} empty={empty} expanded={expanded} />
      </CardContent>
    </Card>
  );
}

/** The trace behind a bar that opens a drawer, for narrow screens. */
export function TraceDrawer({ steps, live, empty, className }: { steps: TraceStep[]; live?: boolean; empty?: string; className?: string }) {
  const blocked = steps.filter((s) => s.status === "blocked").length;
  return (
    <div className={className}>
      <Drawer>
        <DrawerTrigger asChild>
          <button type="button" className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl bg-card px-4 text-left text-sm font-medium ring-1 ring-foreground/10">
            <span>
              Under the hood
              <span className="ml-2 font-normal text-muted-foreground">{steps.length ? `${steps.length} steps${blocked ? `, ${blocked} blocked` : ""}` : "nothing yet"}</span>
            </span>
            <span className="flex items-center gap-3">
              <Status live={live} />
              <ChevronUp className="size-4 text-muted-foreground" aria-hidden="true" />
            </span>
          </button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader className="text-left">
            <DrawerTitle className="font-heading text-lg tracking-[-0.02em]">Under the hood</DrawerTitle>
            <DrawerDescription>Every step the server took for the last thing you did. Tap a step for its detail.</DrawerDescription>
          </DrawerHeader>
          <div className="max-h-[60dvh] overflow-y-auto px-4 pb-8">
            <Steps steps={steps} empty={empty} />
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

/** On the Ask tab: a panel pinned to the right on a wide screen, a drawer on a narrow one. */
export function Trace({ steps, live }: { steps: TraceStep[]; live: boolean }) {
  const empty = "Ask something. Every check the server runs before it answers shows up here as it happens.";
  return (
    <>
      <TraceCard steps={steps} live={live} empty={empty} className="fixed top-24 right-6 hidden max-h-[calc(100dvh-240px)] w-[300px] overflow-y-auto xl:flex" />
      <TraceDrawer steps={steps} live={live} empty={empty} className="mt-4 w-full max-w-[34em] xl:hidden" />
    </>
  );
}
