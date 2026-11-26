import { ArrowDown, ArrowLeft, ArrowRight, Ban, BarChart3, Check, ChevronRight, ClipboardCheck, Hand, Hourglass, Inbox, LifeBuoy, RotateCw, Search, Send, SkipForward, Waypoints, X } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Rise, ScoreRing } from "@/components/motion";
import { TraceCard } from "@/components/Trace";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { askData, decideFlow, getData, getDemo, getFlow, researchDemo, runDemo, runFlow, type Block, type Config, type DataAnswer, type DemoRun, type FlowKind, type Route } from "@/lib/api";
import type { TraceStep } from "@/lib/live";
import { cn } from "@/lib/utils";

const WAITING: TraceStep[] = [{ id: "wait", label: "Starting", status: "running", detail: "Waiting for the server.", ms: 0 }];

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;

/** Shows the server's steps one at a time, so the screen can keep pace with them. */
function useReveal(total: number) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (total === 0) return setShown(0);
    if (reduce) return setShown(total);
    if (shown >= total) return;
    const timer = setTimeout(() => setShown((n) => Math.min(total, n + 1)), 420);
    return () => clearTimeout(timer);
  }, [shown, total, reduce]);
  return Math.min(shown, total);
}

// ------------------------------------------------------------------ the agents

/** One card in the library. Each agent does one job, on made-up input the site chooses. */
type Agent = { key: string; demoId: string; name: string; role: string } & (
  | { kind: "research" }
  | { kind: "outreach"; leads: { id: string; name: string }[] }
  | { kind: "data"; questions: string[] }
  | { kind: "flow"; flow: FlowKind; company: string; inputs: { id: string; label: string }[] }
);

type Look = "research" | "outreach" | "data" | FlowKind;
const lookOf = (agent: Agent): Look => (agent.kind === "flow" ? agent.flow : agent.kind);

const LOOKS = [
  "bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300",
  "bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300",
  "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300",
  "bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300",
  "bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-300",
  "bg-cyan-100 text-cyan-600 dark:bg-cyan-500/20 dark:text-cyan-300",
];

const BADGE = { research: Search, outreach: Send, data: BarChart3, desk: Waypoints, support: LifeBuoy, intake: Inbox, review: ClipboardCheck } as const;

/** A small robot face. The colour and the face change with the agent's place in the list. */
function BotAvatar({ index, kind, size = 56 }: { index: number; kind: Look; size?: number }) {
  const Icon = BADGE[kind];
  const face = index % 3;
  return (
    <Avatar size="lg" style={{ width: size, height: size }} aria-hidden="true">
      <AvatarFallback className={LOOKS[index % LOOKS.length]}>
      <svg viewBox="0 0 48 48" width={size * 0.7} height={size * 0.7} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M24 6v5" />
        <circle cx="24" cy="5" r="1.6" fill="currentColor" stroke="none" />
        <rect x="9" y="11" width="30" height="26" rx="9" />
        <path d="M5 22v6M43 22v6" />
        {face === 0 && (
          <>
            <circle cx="18" cy="22" r="2.6" fill="currentColor" stroke="none" />
            <circle cx="30" cy="22" r="2.6" fill="currentColor" stroke="none" />
            <path d="M19 30c3 2.4 7 2.4 10 0" />
          </>
        )}
        {face === 1 && (
          <>
            <rect x="14.5" y="19" width="19" height="6.5" rx="3.25" fill="currentColor" stroke="none" />
            <path d="M20 31h8" />
          </>
        )}
        {face === 2 && (
          <>
            <path d="M15.5 23c1.4-2.4 3.6-2.4 5 0M27.5 23c1.4-2.4 3.6-2.4 5 0" />
            <path d="M20 30.5c2.6 1.6 5.4 1.6 8 0" />
          </>
        )}
      </svg>
      </AvatarFallback>
      <AvatarBadge className="size-5! [&>svg]:size-3!">
        <Icon />
      </AvatarBadge>
    </Avatar>
  );
}

async function loadAgents(config: Config): Promise<Agent[]> {
  const agents: Agent[] = [];
  for (const demo of config.demos ?? []) {
    if (demo.type === "flow") {
      const info = await getFlow(demo.id);
      agents.push({ key: `${demo.id}:flow`, demoId: demo.id, kind: "flow", flow: info.flow, name: info.agentName, role: info.role, company: info.company, inputs: info.scenarios });
      continue;
    }
    if (demo.type === "data") {
      const info = await getData(demo.id);
      agents.push({ key: `${demo.id}:data`, demoId: demo.id, kind: "data", name: info.agentName, role: "Answers questions about an operations dashboard in plain words.", questions: info.examples });
      continue;
    }
    const info = await getDemo(demo.id);
    const role = (name: string, fallback: string) => info.agents.find((a) => a.name === name)?.role || fallback;
    if (info.researchCases.length) {
      const name = info.researcherName || "Research agent";
      agents.push({ key: `${demo.id}:research`, demoId: demo.id, kind: "research", name, role: role(name, "Finds a company, researches it and scores it.") });
    }
    const name = info.senderName || "Outreach agent";
    agents.push({ key: `${demo.id}:outreach`, demoId: demo.id, kind: "outreach", name, role: role(name, "Scores a lead and drafts the email."), leads: info.cases.map((c) => ({ id: c.id, name: c.name })) });
  }
  return agents;
}

// ------------------------------------------------------------------ what a run shows

function Loading() {
  return (
    <div className="grid gap-3" role="status" aria-label="Working">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function ModelBadge({ route }: { route?: Route }) {
  if (!route?.called) return null;
  return (
    <Badge variant="secondary" className="tabular-nums">
      {route.model}, {usd(route.costMicroUsd)}
    </Badge>
  );
}

function Score({ run }: { run: DemoRun }) {
  const agent = run.steps.find((s) => s.kind === "score")?.agent ?? "";
  const score = run.score!;
  return (
    <Rise className="grid gap-4">
      <p className="text-sm font-medium">{agent} score</p>
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:gap-7">
        <ScoreRing value={score.total} max={score.outOf} size={116} />
        <ul className="grid w-full gap-3">
          {score.lines.map((line) => (
            <li key={line.id} className="grid gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>{line.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {line.points} of {line.max}
                </span>
              </div>
              <Progress value={(Math.max(0, line.points) / line.max) * 100} className="h-1.5" aria-label={line.label} />
            </li>
          ))}
        </ul>
      </div>
      {run.path && <p className="text-sm text-muted-foreground">{run.path.label}</p>}
      <Collapsible>
        <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          Evidence behind each point
          <ChevronRight className="size-4 transition-transform group-aria-expanded:rotate-90" aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-3 grid gap-2 border-l pl-4 text-sm text-muted-foreground">
            {score.lines.flatMap((line) =>
              line.evidence.map((e, i) => (
                <li key={`${line.id}${i}`} className={cn(!e.counted && "opacity-60")}>
                  <span className="text-foreground">
                    {line.label}, {e.counted ? `+${e.points}` : "not counted"}:
                  </span>{" "}
                  {e.fact} ({e.source})
                </li>
              )),
            )}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </Rise>
  );
}

function Blocked({ run }: { run: DemoRun }) {
  const stop = [...run.steps].reverse().find((s) => s.status === "blocked");
  return (
    <Rise>
      <Alert variant="destructive">
        <Ban />
        <AlertTitle>Stopped: {stop?.title ?? "a check failed"}</AlertTitle>
        <AlertDescription>{stop?.detail} No draft is written for a company that fails a check.</AlertDescription>
      </Alert>
    </Rise>
  );
}

function Handover({ from, to }: { from: string; to: string }) {
  return (
    <Rise>
      <Marker variant="separator">
        <MarkerIcon>
          <ArrowDown />
        </MarkerIcon>
        <MarkerContent>
          {from} hands over to the {to}
        </MarkerContent>
      </Marker>
    </Rise>
  );
}

/** The email the agent wrote. It is shown, never sent: the run ends where a person would decide. */
function Draft({ run }: { run: DemoRun }) {
  const draft = run.draft!;
  return (
    <Rise className="grid gap-4">
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Draft email</p>
        <ModelBadge route={run.route} />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">To</dt>
        <dd className="break-words">{draft.to}</dd>
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="break-words">{draft.subject}</dd>
      </dl>
      <p className="rounded-lg bg-muted/60 p-4 text-sm leading-relaxed whitespace-pre-wrap">{draft.body}</p>
      <Marker>
        <MarkerIcon>
          <Hourglass />
        </MarkerIcon>
        <MarkerContent>{run.needsApproval ? "The agent stops here and waits for a person to approve these exact words." : "A low score needs no approval. It would go out once every check passes."}</MarkerContent>
      </Marker>
    </Rise>
  );
}

function Answer({ answer }: { answer: DataAnswer }) {
  return (
    <>
      <Rise>
        <p className="text-base leading-relaxed">{answer.answer}</p>
      </Rise>
      {answer.ok && answer.columns && answer.rows && (
        <Rise className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                {answer.columns.map((c) => (
                  <TableHead key={c} className="capitalize">
                    {c}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {answer.rows.map((row, i) => (
                <TableRow key={i}>
                  {row.map((cell, j) => (
                    <TableCell key={j} className={cn(typeof cell === "number" && "tabular-nums")}>
                      {typeof cell === "number" ? cell.toLocaleString("en-US") : cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Rise>
      )}
      {answer.sql && (
        <Rise>
          <CodeBlock>
            <CodeBlockHeader>
              <CodeBlockTitle>The query that ran</CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton value={answer.sql} />
              </CodeBlockActions>
            </CodeBlockHeader>
            <CodeBlockContent>{answer.sql}</CodeBlockContent>
          </CodeBlock>
        </Rise>
      )}
    </>
  );
}

// ------------------------------------------------------------------ one agent at work

type Result =
  | { kind: "run"; run: DemoRun }
  | { kind: "research"; research: DemoRun; outreach: DemoRun }
  | { kind: "data"; answer: DataAnswer }
  | { kind: "flow"; blocks: Block[]; draft?: { subject: string; body: string } };

type Decision = { decision: string; id: string } | null;

const BOX = "rounded-lg border bg-muted/40 p-4 text-sm leading-relaxed whitespace-pre-wrap";

/** The pieces of a run, each shown once the server step before it has appeared. */
function Blocks({ blocks, shown, decision, busy, onDecide }: { blocks: Block[]; shown: number; decision: Decision; busy: boolean; onDecide: (d: "approve" | "reject") => void }) {
  return (
    <>
      {blocks
        .filter((b) => b.after <= shown)
        .map((b, i) => {
          if (b.type === "message") {
            return (
              <Rise key={i} className="grid gap-2">
                <p className="text-sm font-medium">{b.label}</p>
                <div className={BOX}>
                  {b.from && (
                    <p className="mb-2 text-muted-foreground">
                      From {b.from}
                      {b.subject && `, "${b.subject}"`}
                    </p>
                  )}
                  {b.body}
                </div>
              </Rise>
            );
          }
          if (b.type === "answer") {
            return (
              <Rise key={i} className="grid gap-2">
                <p className="text-sm font-medium">{b.label}</p>
                <p className="text-base leading-relaxed">{b.text}</p>
                {b.source && (
                  <p className="border-l-2 border-primary/40 pl-3 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">Source: {b.source.title}.</span> {b.source.excerpt}
                  </p>
                )}
              </Rise>
            );
          }
          if (b.type === "fields") {
            return (
              <Rise key={i} className="grid gap-2">
                <p className="text-sm font-medium">{b.label}</p>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg border p-4 text-sm">
                  {b.rows.map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className={cn("break-words", value === "not given" && "text-muted-foreground italic")}>{value}</dd>
                    </div>
                  ))}
                </dl>
              </Rise>
            );
          }
          if (b.type === "draft") {
            return (
              <Rise key={i} className="grid gap-2">
                <p className="text-sm font-medium">{b.label}</p>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                  {b.to && (
                    <>
                      <dt className="text-muted-foreground">To</dt>
                      <dd className="break-words">{b.to}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Subject</dt>
                  <dd className="break-words">{b.subject}</dd>
                </dl>
                <p className={BOX}>{b.body}</p>
              </Rise>
            );
          }
          if (b.type === "handover") {
            return (
              <Rise key={i}>
                <Marker variant="separator">
                  <MarkerIcon>
                    <ArrowDown />
                  </MarkerIcon>
                  <MarkerContent>{b.text}</MarkerContent>
                </Marker>
              </Rise>
            );
          }
          if (b.type === "output") {
            return (
              <Rise key={i} className="grid gap-2">
                <p className="text-sm font-medium">{b.label}</p>
                <p className={BOX}>{b.text}</p>
              </Rise>
            );
          }
          if (b.type === "checklist") {
            return (
              <Rise key={i} className="grid gap-2">
                <p className="text-sm font-medium">{b.label}</p>
                <ul className="grid gap-2 rounded-lg border p-4 text-sm">
                  {b.items.map((item) => (
                    <li key={item.label} className="flex gap-2.5">
                      {item.pass ? <Check className="mt-0.5 size-4 flex-none text-emerald-600" aria-label="Passed" /> : <X className="mt-0.5 size-4 flex-none text-destructive" aria-label="Failed" />}
                      <span>
                        {item.label}
                        {!item.pass && item.note && <span className="block text-muted-foreground">{item.note}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </Rise>
            );
          }
          if (b.type === "note") {
            return (
              <Rise key={i}>
                <Alert>
                  {b.tone === "stop" ? <Hand /> : b.tone === "ok" ? <Check /> : <Hourglass />}
                  <AlertTitle>{b.title}</AlertTitle>
                  <AlertDescription>{b.text}</AlertDescription>
                </Alert>
              </Rise>
            );
          }
          return (
            <Rise key={i} className="grid gap-3">
              <Separator />
              {decision ? (
                <Alert>
                  {decision.decision === "approve" ? <Check /> : <Ban />}
                  <AlertTitle>{decision.decision === "approve" ? "Approved" : "Rejected"}</AlertTitle>
                  <AlertDescription>
                    {decision.decision === "approve" ? "Cleared to send. This is a demo, so nothing was sent." : "Nothing is sent. The draft is dropped."} Record {decision.id}.
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">The agent has stopped. You are the person it waits for.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="lg" disabled={busy} onClick={() => onDecide("approve")}>
                      <Check aria-hidden="true" /> Approve
                    </Button>
                    <Button size="lg" variant="outline" disabled={busy} onClick={() => onDecide("reject")}>
                      <Ban aria-hidden="true" /> Reject
                    </Button>
                  </div>
                </>
              )}
            </Rise>
          );
        })}
    </>
  );
}

const scoreAt = (run: DemoRun) => {
  const i = run.steps.findIndex((s) => s.kind === "score");
  return i < 0 ? Infinity : i + 1;
};

/** The agent starts by itself on input the site picked. The visitor watches. */
function AgentView({ agent, index, onBack }: { agent: Agent; index: number; onBack: () => void }) {
  const [turn, setTurn] = useState(0); // which lead or question; "next" moves it on
  const [again, setAgain] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [trace, setTrace] = useState<TraceStep[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const shown = useReveal(trace.length);

  const [decision, setDecision] = useState<Decision>(null);
  const [deciding, setDeciding] = useState(false);
  const input =
    agent.kind === "outreach" ? agent.leads[turn % agent.leads.length]?.name : agent.kind === "data" ? agent.questions[turn % agent.questions.length] : agent.kind === "flow" ? agent.inputs[turn % agent.inputs.length]?.label : undefined;

  const run = useCallback(async (): Promise<{ result: Result; trace: TraceStep[] }> => {
    if (agent.kind === "research") {
      const data = await researchDemo(agent.demoId);
      return { result: { kind: "research", research: data.research, outreach: data.outreach }, trace: data.trace };
    }
    if (agent.kind === "outreach") {
      const data = await runDemo(agent.demoId, agent.leads[turn % agent.leads.length].id);
      return { result: { kind: "run", run: data }, trace: data.trace ?? [] };
    }
    if (agent.kind === "flow") {
      const data = await runFlow(agent.demoId, agent.inputs[turn % agent.inputs.length].id);
      return { result: { kind: "flow", blocks: data.blocks, draft: data.draft }, trace: data.trace };
    }
    const data = await askData(agent.demoId, agent.questions[turn % agent.questions.length]);
    return { result: { kind: "data", answer: data }, trace: data.trace ?? [] };
  }, [agent, turn]);

  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    setResult(null);
    setTrace([]);
    setDecision(null);
    run()
      .then((done) => {
        if (!live) return;
        setResult(done.result);
        setTrace(done.trace);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Try again."))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [run, again]);

  /** Approve or reject the drafted reply. The server answers with the approval record and its steps. */
  async function decide(choice: "approve" | "reject") {
    if (agent.kind !== "flow" || result?.kind !== "flow" || !result.draft || deciding) return;
    setDeciding(true);
    try {
      const data = await decideFlow(agent.demoId, agent.inputs[turn % agent.inputs.length].id, choice, result.draft);
      setDecision({ decision: data.record.decision, id: data.record.id });
      setTrace((all) => [...all, ...data.trace.map((s, i) => ({ ...s, id: `a${all.length + i}` }))]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again.");
    }
    setDeciding(false);
  }

  const done = !busy && shown >= trace.length;
  const first = result?.kind === "research" ? result.research : result?.kind === "run" ? result.run : null;
  const title = first ? first.case.name : agent.kind === "data" || agent.kind === "flow" ? input : "Working";
  const hint = first ? first.case.summary : agent.kind === "data" ? "A question the site picked. The data is made up." : agent.kind === "flow" ? "Picked by the site. Everything in it is made up." : "On a made-up company the site picked.";
  const NEXT = { desk: "Next message", support: "Next question", intake: "Next email", review: "Next task" } as const;
  const next = agent.kind === "outreach" ? "Next lead" : agent.kind === "data" ? "Next question" : agent.kind === "flow" ? NEXT[agent.flow] : "";

  const ending = (r: DemoRun) => shown >= trace.length && (r.outcome === "blocked" ? <Blocked run={r} /> : r.draft && <Draft run={r} />);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="ghost" className="h-11 px-3" onClick={onBack}>
          <ArrowLeft aria-hidden="true" /> All agents
        </Button>
        <BotAvatar index={index} kind={lookOf(agent)} size={48} />
        <div className="min-w-0 flex-1 text-left">
          <h2 className="text-xl tracking-[-0.02em]">{agent.name}</h2>
          <p className="text-sm text-muted-foreground">{agent.role}</p>
        </div>
        <div className="flex gap-2">
          {next && (
            <Button variant="outline" className="h-11 px-4" disabled={!done} onClick={() => setTurn((n) => n + 1)}>
              <SkipForward aria-hidden="true" /> {next}
            </Button>
          )}
          <Button variant="outline" className="h-11 px-4" disabled={!done} onClick={() => setAgain((n) => n + 1)}>
            <RotateCw aria-hidden="true" /> Run again
          </Button>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <TraceCard
          steps={busy && !trace.length ? WAITING : trace.slice(0, shown)}
          description="Every step the server takes for this run, as it happens."
          empty="Starting."
          expanded
          className="lg:order-2"
        />
        <Card className="min-w-0 text-left lg:order-1">
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{hint}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {error && (
              <Alert variant="destructive">
                <Ban />
                <AlertTitle>That didn't work</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {!error && !result && <Loading />}

            {result?.kind === "run" && (
              <>
                {result.run.score && shown >= scoreAt(result.run) ? <Score run={result.run} /> : shown < trace.length && <Loading />}
                {ending(result.run)}
              </>
            )}

            {result?.kind === "research" && (
              <>
                {result.research.score && shown >= scoreAt(result.research) ? <Score run={result.research} /> : <Loading />}
                {shown >= result.research.steps.length && <Handover from={result.research.steps[0]?.agent ?? "Research agent"} to={result.outreach.steps.at(-1)?.agent ?? "Outreach agent"} />}
                {result.outreach.score && shown >= result.research.steps.length + scoreAt(result.outreach) && <Score run={result.outreach} />}
                {ending(result.outreach)}
              </>
            )}

            {result?.kind === "data" && (shown >= trace.length ? <Answer answer={result.answer} /> : <Loading />)}

            {result?.kind === "flow" && <Blocks blocks={result.blocks} shown={shown} decision={decision} busy={deciding} onDecide={decide} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the library

interface Props {
  config: Config;
  /** A demo the conversation asked to open. */
  active: string;
  onActive: (id: string) => void;
}

/** The Live demos tab: a shelf of agents. Pick one and watch it do its job. */
export function Workbench({ config, active, onActive }: Props) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    loadAgents(config)
      .then(setAgents)
      .catch(() => setError("The agents didn't load. Reload the page."));
  }, [config]);

  // "Show me the outreach agents" in the conversation opens the first agent of that demo.
  useEffect(() => {
    if (!active || !agents) return;
    const wanted = agents.find((a) => a.demoId === active);
    if (wanted) setOpen(wanted.key);
    onActive("");
  }, [active, agents, onActive]);

  // Opening or leaving an agent starts at the top of the page.
  useEffect(() => {
    // In newer browsers scrollTo returns a promise, which an effect must not return.
    void window.scrollTo({ top: 0 });
  }, [open]);

  const index = agents?.findIndex((a) => a.key === open) ?? -1;
  const current = index >= 0 ? agents![index] : null;

  let body: ReactNode;
  if (current) {
    body = <AgentView key={current.key} agent={current} index={index} onBack={() => setOpen(null)} />;
  } else {
    body = (
      <>
        <div className="grid justify-items-center gap-3 text-center">
          <h1 className="text-2xl tracking-[-0.03em] sm:text-3xl">Agents {config.firstName} built</h1>
          <p className="max-w-[52ch] text-sm text-muted-foreground">Pick one and watch it work. The companies and numbers are made up, and nothing is sent.</p>
        </div>
        {error && (
          <Alert variant="destructive">
            <Ban />
            <AlertTitle>That didn't work</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <ul className="mx-auto grid w-full max-w-[1180px] gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {!agents && !error && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-52 rounded-xl" />)}
          {agents?.map((agent, i) => (
            <li key={agent.key}>
              <button
                type="button"
                onClick={() => setOpen(agent.key)}
                className="group flex h-full w-full flex-col gap-4 rounded-xl bg-card p-5 text-left ring-1 ring-foreground/10 transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgb(23_32_57/0.10)] hover:ring-primary/50 focus-visible:ring-2 focus-visible:ring-primary"
              >
                <BotAvatar index={i} kind={lookOf(agent)} size={64} />
                <span className="grid gap-1">
                  <span className="font-heading text-base font-semibold">{agent.name}</span>
                  <span className="text-sm text-muted-foreground">{agent.role}</span>
                </span>
                <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-link">
                  Watch it work <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return <div className="mx-auto grid max-w-[1280px] gap-6 px-4 pt-6 pb-16 sm:px-6">{body}</div>;
}
