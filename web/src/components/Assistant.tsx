import { ArrowRight, Captions, CaptionsOff, Mic, Volume2, VolumeX } from "lucide-react";
import { toast } from "sonner";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ThemeToggle, Title } from "@/components/common";
import { ContactDialog } from "@/components/ContactDialog";
import { Orb } from "@/components/Orb";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Workbench } from "@/components/Workbench";
import { Trace } from "@/components/Trace";
import { ask, type Config, type Reply } from "@/lib/api";
import { upsert, useLive, type RequestState, type TraceStep } from "@/lib/live";
import type { Mood, OrbHandle } from "@/lib/orb";
import { Voice } from "@/lib/voice";
import { cn } from "@/lib/utils";

interface Props {
  config: Config;
  dark: boolean;
  onToggleTheme: () => void;
  onSignedOut: () => void;
}

const TAB = "px-4 font-heading font-semibold data-active:bg-primary! data-active:text-primary-foreground!";

type Recognition = { start(): void; stop(): void; lang: string; interimResults: boolean; onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null };

const requestWords = (name: string): Record<RequestState, string> => ({
  pending: `Your request is with ${name}. Waiting for a decision.`,
  approved: `${name} approved your request and will reply by email.`,
  sent: `${name} has replied to you by email.`,
  declined: `${name} can't take this one right now.`,
});

const HOW = (name: string, days: number) => [
  `It answers only from a small knowledge base of projects and achievements that ${name} wrote. It has no other facts.`,
  "Every answer links its source. A check in code, separate from the model, drops any answer that has none.",
  `If the notes don't cover your question it says so, and offers a way to ask ${name} directly.`,
  `It can't send, book or promise anything. A request to talk waits until ${name} approves it.`,
  `Conversations are logged and ${name} can read them. Logs are deleted after ${days} days.`,
];

/** The voice-first page: the shape, small captions, and a box to type in. */
export function Assistant({ config, dark, onToggleTheme, onSignedOut }: Props) {
  const orb = useRef<OrbHandle | null>(null);
  const voice = useMemo(() => new Voice(() => orb.current), []);
  const recognition = useRef<Recognition | null>(null);
  const asked = useRef<string[]>([]);
  const started = useRef(false);

  const [mood, setMoodState] = useState<Mood>("idle");
  const [hint, setHint] = useState("Tap to start");
  const [reply, setReply] = useState<Reply>({ kind: "smalltalk", text: config.opening, sources: [], openContact: false });
  const [question, setQuestion] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [showStarters, setShowStarters] = useState(true);
  const [contactOpen, setContactOpen] = useState(false);
  const [canListen, setCanListen] = useState(false);
  const [trace, setTrace] = useState<TraceStep[]>([]);
  const [request, setRequest] = useState<{ id: string; state: RequestState } | null>(null);
  const [demo, setDemo] = useState("");
  // True while the question box has focus. On a phone the keyboard takes half the
  // screen, so everything that isn't the assistant or the box steps aside.
  const [typing, setTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusBox = (on: boolean) => {
    clearTimeout(typingTimer.current);
    if (on) {
      setTyping(true);
      // Keep the assistant in view: without this the browser scrolls down to the box.
      for (const wait of [0, 250, 500]) setTimeout(() => window.scrollTo({ top: 0 }), wait);
    } else {
      // A short wait, so a tap on Send lands before the layout changes back.
      typingTimer.current = setTimeout(() => setTyping(false), 200);
    }
  };
  const hasDemos = (config.demos?.length ?? 0) > 0;
  const [tab, setTabState] = useState<"ask" | "demos">(() => (hasDemos && location.hash === "#demos" ? "demos" : "ask"));
  const [seenDemos, setSeenDemos] = useState(tab === "demos");
  const turn = useRef("");
  const requestRef = useRef<{ id: string; state: RequestState } | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const setMood = useCallback((next: Mood, label: string) => {
    orb.current?.setMood(next);
    setMoodState(next);
    setHint(label);
  }, []);

  const idle = useCallback(() => {
    setMood("idle", !started.current ? "Tap to start" : recognition.current ? "Tap to speak, or type below" : "Ask me anything");
  }, [setMood]);

  const say = useCallback(
    async (next: Reply) => {
      if (mutedRef.current || !started.current) return idle();
      setMood("speaking", "Speaking. Tap to stop");
      const result = await voice.speak(next, config.voice);
      if (result === "silent") setCaptions(true); // no voice on this device: make sure the words show
      if (result !== "stopped") idle();
    },
    [config.voice, idle, setMood, voice],
  );

  const send = useCallback(
    async (text: string) => {
      const message = text.trim().slice(0, config.maxMessageChars);
      if (!message || busy) return;
      // No started.current here: typing a question does not switch the voice on.
      // The orb or the microphone does that.
      voice.unlock();
      voice.stop();
      setBusy(true);
      setShowStarters(false);
      setQuestion(message);
      setReply({ kind: "smalltalk", text: "", sources: [], openContact: false });
      setMood("thinking", "Thinking");
      setTrace([]);
      turn.current = "";
      const next = await ask(message, asked.current.slice(-4));
      asked.current.push(message);
      setBusy(false);
      if (next === "signed-out") return onSignedOut();
      // The reply carries the finished trace. It replaces whatever arrived live.
      if (next.trace) setTrace(next.trace);
      setReply(next);
      void say(next);
    },
    [busy, config.maxMessageChars, onSignedOut, say, setMood, voice],
  );

  // Live updates from the server: the steps behind an answer as they happen,
  // and the owner's decision on a contact request.
  const sayRef = useRef(say);
  sayRef.current = say;
  const live = useLive((event) => {
    if (event.type === "trace") {
      if (event.turn !== turn.current) {
        turn.current = event.turn;
        setTrace([event.step]);
      } else {
        setTrace((steps) => upsert(steps, event.step));
      }
      return;
    }
    const before = requestRef.current;
    requestRef.current = { id: event.id, state: event.state };
    setRequest(requestRef.current);
    // Speak up only when a request this page already knew about gets decided.
    if (before?.id === event.id && before.state !== event.state && (event.state === "approved" || event.state === "declined")) {
      const next: Reply = { kind: "contact", text: requestWords(config.firstName)[event.state], sources: [], openContact: false };
      if (event.state === "approved") toast.success(next.text);
      else toast(next.text);
      setQuestion("");
      setReply(next);
      void sayRef.current(next);
    }
  });

  // Voice input, where the browser has it.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) return;
    const r: Recognition = new Ctor();
    r.lang = "en-US";
    r.interimResults = true;
    r.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const heard = String(result[0].transcript).trim();
      setQuestion(heard);
      if (result.isFinal && heard) void sendRef.current(heard);
    };
    r.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        recognition.current = null;
        setCanListen(false);
        setMood("idle", "Microphone is blocked. Type your question below");
      } else {
        idle();
      }
    };
    r.onend = () => setMoodState((m) => (m === "listening" ? (orb.current?.setMood("idle"), "idle") : m));
    recognition.current = r;
    setCanListen(true);
    return () => {
      r.onresult = r.onerror = r.onend = null;
      try {
        r.stop();
      } catch {
        /* not running */
      }
    };
  }, [idle, setMood]);

  useEffect(() => () => voice.stop(), [voice]);

  function listen() {
    const r = recognition.current;
    if (!r || busy) return document.getElementById("question")?.focus();
    if (mood === "listening") return r.stop();
    voice.stop();
    try {
      r.start();
      setMood("listening", "Listening");
    } catch {
      idle();
    }
  }

  // The shape is the main control: start, stop the voice, or start listening.
  function tapOrb() {
    voice.unlock();
    if (!started.current) {
      started.current = true;
      void say(reply);
      return;
    }
    if (mood === "speaking") {
      voice.stop();
      idle();
      return;
    }
    if (!busy) listen();
  }

  function toggleMuted() {
    const next = !muted;
    setMuted(next);
    if (next) {
      voice.stop();
      setCaptions(true); // never leave the visitor with neither sound nor words
      idle();
    }
  }

  function toggleCaptions() {
    if (captions && muted) setMuted(false);
    setCaptions(!captions);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft;
    setDraft("");
    (document.activeElement as HTMLElement | null)?.blur();
    void send(text);
  }

  /** The two halves of the site: ask about the person, or try what they built. */
  function setTab(next: "ask" | "demos", demoId?: string) {
    if (next === "demos") {
      voice.stop();
      idle();
      setSeenDemos(true);
      if (demoId) setDemo(demoId);
    }
    setTabState(next);
    history.replaceState(null, "", next === "demos" ? "#demos" : location.pathname);
    window.scrollTo({ top: 0 });
  }

  function openContact() {
    voice.stop();
    idle();
    setContactOpen(true);
  }

  const quiet = "size-10 px-0 text-[13px] font-medium text-muted-foreground sm:h-9 sm:w-auto sm:px-3";
  const starters = config.starters.filter((s) => !config.demos?.some((d) => d.starter === s));
  const refusal = reply.kind === "unknown" || reply.kind === "off_limits" || reply.kind === "limit";

  return (
    <>
      <header className="mx-auto grid max-w-[1280px] grid-cols-2 items-center gap-x-3 gap-y-2.5 px-4 pt-3.5 sm:px-6 sm:pt-5 md:grid-cols-[1fr_auto_1fr]">
        <Title text={config.title} className="text-xl font-bold tracking-[-0.03em] whitespace-nowrap" />
        {hasDemos && (
          <Tabs value={tab} onValueChange={(next) => setTab(next as "ask" | "demos")} className="relative order-3 col-span-2 md:order-none md:col-span-1">
            <TabsList className="h-11! w-full md:w-auto">
              <TabsTrigger value="ask" className={TAB}>
                Ask about {config.firstName}
              </TabsTrigger>
              <TabsTrigger value="demos" className={TAB}>
                Live demos
              </TabsTrigger>
            </TabsList>
            {tab === "ask" && !seenDemos && (
              <button type="button" onClick={() => setTab("demos")} className={cn("-mt-1 flex w-full items-start justify-end gap-1.5 pr-[16%] text-primary md:hidden dark:text-link", typing && "hidden")}>
                <span className="mt-3.5 -rotate-2 text-right font-['Caveat',cursive] text-[20px] leading-none font-semibold">Come check out the agents I've built</span>
                <svg viewBox="0 0 60 50" className="h-9 w-11 flex-none -scale-x-100" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M54 44C32 45 13 35 11 8" />
                  <path d="M3 17l8-10 8 9" />
                </svg>
              </button>
            )}
            {tab === "ask" && !seenDemos && (
              <span aria-hidden="true" className="pointer-events-none hidden items-start gap-1 text-primary md:absolute md:top-full md:left-[56%] md:mt-0.5 md:flex md:w-[250px] dark:text-link">
                <svg viewBox="0 0 60 50" className="h-10 w-12 flex-none" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M54 44C32 45 13 35 11 8" />
                  <path d="M3 17l8-10 8 9" />
                </svg>
                <span className="mt-4 -rotate-2 font-['Caveat',cursive] text-[21px] leading-[1.05] font-semibold">Come check out the agents I've built here</span>
              </span>
            )}
          </Tabs>
        )}
        <div className={cn("flex justify-end gap-1.5 sm:gap-2", !hasDemos && "md:col-start-3")}>
          {tab === "ask" && (
            <>
              <Button variant="outline" className={quiet} aria-pressed={!muted} aria-label={muted ? "Sound off" : "Sound on"} onClick={toggleMuted}>
                {muted ? <VolumeX className="sm:hidden" /> : <Volume2 className="sm:hidden" />}
                <span className="hidden sm:inline">{muted ? "Sound off" : "Sound on"}</span>
              </Button>
              <Button variant="outline" className={quiet} aria-pressed={captions} aria-label={captions ? "Captions on" : "Captions off"} onClick={toggleCaptions}>
                {captions ? <Captions className="sm:hidden" /> : <CaptionsOff className="sm:hidden" />}
                <span className="hidden sm:inline">{captions ? "Captions on" : "Captions off"}</span>
              </Button>
            </>
          )}
          <ThemeToggle dark={dark} onToggle={onToggleTheme} />
        </div>
      </header>

      {seenDemos && (
        <div hidden={tab !== "demos"}>
          <Workbench config={config} active={demo} onActive={setDemo} />
        </div>
      )}

      <div hidden={tab !== "ask"}>
      <main className={cn("mx-auto flex max-w-[720px] flex-col items-center justify-center px-4 pt-1 pb-6 text-center sm:min-h-[calc(100dvh-56px-128px)] sm:px-6 sm:pt-2 sm:pb-8", typing ? "max-sm:min-h-0 max-sm:justify-start max-sm:pb-24" : "max-sm:min-h-[calc(100dvh-365px)]")}>
        <button
          type="button"
          onClick={tapOrb}
          aria-label={started.current ? "The assistant. Tap to speak or to stop the voice." : "The assistant. Tap to start."}
          className="aspect-square w-[min(52vw,26dvh,320px)] rounded-full sm:w-[min(64vw,38dvh,320px)] outline-offset-[-18px] [-webkit-tap-highlight-color:transparent]"
        >
          <Orb ref={orb} dark={dark} />
        </button>

        <p className={cn("mt-1 mb-5 min-h-[1.2em] text-[13.5px] leading-tight font-medium transition-colors duration-300", mood === "speaking" || mood === "listening" ? "text-link" : "text-dim")}>
          {hint}
        </p>

        <section aria-live="polite" className="w-full">
          {captions && question && <p className="mb-2 text-[13.5px] break-words text-dim">You asked: {question}</p>}
          {captions && (
            <p className={cn("mx-auto max-w-[34em] text-[16.5px] leading-relaxed break-words whitespace-pre-wrap", refusal ? "text-foreground" : "text-muted-foreground")}>
              {reply.text}
            </p>
          )}
          {reply.sources.length > 0 && (
            <ul className="mt-3.5 flex flex-wrap justify-center gap-2">
              {reply.sources.map((source) => (
                <li key={source.id}>
                  <Button asChild variant="outline" className="h-[34px] bg-card px-3 text-[13px] font-medium text-link">
                    <a href={source.url} target="_blank" rel="noopener" title={source.title}>
                      <span className="font-normal text-dim">Source:</span> {source.source}
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {reply.demo && (
            <div className="mt-3.5 flex justify-center">
              <Button className="h-11 px-4" onClick={() => setTab("demos", reply.demo)}>
                Open the live demo <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          )}
          {reply.openContact && (
            <div className="mt-2.5 flex justify-center">
              <Button variant="outline" className="h-[34px] bg-card px-3 text-[13px] font-medium text-link" onClick={openContact}>
                Talk to the real {config.firstName}
              </Button>
            </div>
          )}
        </section>

        {request && (
          <p
            role="status"
            className={cn(
              "mt-4 inline-flex min-h-9 items-center gap-2 rounded-full border bg-card px-3.5 text-[13px] font-medium",
              request.state === "approved" || request.state === "sent" ? "border-primary/40 text-link" : "text-muted-foreground",
            )}
          >
            <span className={cn("size-1.5 rounded-full", request.state === "pending" ? "animate-pulse bg-amber-500" : request.state === "declined" ? "bg-dim" : "bg-emerald-500")} aria-hidden="true" />
            {requestWords(config.firstName)[request.state]}
          </p>
        )}

        <Trace steps={trace} live={live} />

        {showStarters && (
          <div className="mt-6 hidden max-w-[640px] flex-wrap justify-center gap-2.5 sm:flex" aria-label="Questions to start with">
            {starters.map((starter) => (
              <Button
                key={starter}
                variant="outline"
                className="h-auto min-h-11 rounded-full bg-card px-4 py-2 text-[14.5px] font-medium whitespace-normal shadow-[0_1px_2px_rgb(23_32_57/0.04)] hover:border-primary"
                onClick={() => void send(starter)}
              >
                {starter}
              </Button>
            ))}
          </div>
        )}

        {config.mode === "stub" && <p className="mt-5 text-[12.5px] text-dim">Stub mode: no model key is set, so answers are quoted from the notes by keyword match.</p>}

      </main>

      <section id="how" aria-labelledby="how-title" className={cn("mx-auto max-w-[720px] border-t px-4 pt-14 pb-[184px] sm:px-6", typing && "max-sm:hidden")}>
        <h2 id="how-title" className="mb-7 text-[clamp(28px,4vw,40px)] leading-[1.05]">
          How this assistant works
        </h2>
        <ol className="grid gap-[18px]">
          {HOW(config.firstName, config.retentionDays).map((line, i) => (
            <li key={i} className="relative max-w-[60ch] pl-11 leading-relaxed text-muted-foreground">
              <span className="absolute top-px left-0 font-heading text-sm leading-relaxed font-semibold text-link">{String(i + 1).padStart(2, "0")}</span>
              {line}
            </li>
          ))}
        </ol>

        {config.stack && config.stack.length > 0 && (
          <details className="group mt-8 rounded-xl border bg-card">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 text-[14px] font-medium [&::-webkit-details-marker]:hidden">
              What this runs on
              <span className="text-[12.5px] font-normal text-dim group-open:hidden">Show</span>
              <span className="hidden text-[12.5px] font-normal text-dim group-open:inline">Hide</span>
            </summary>
            <ul className="grid gap-3 border-t px-4 py-4">
              {config.stack.map((item) => (
                <li key={item.id} className="text-[13.5px] leading-snug">
                  <span className="font-semibold">{item.name}</span>
                  {item.where === "outside" && <span className="ml-2 rounded-md bg-secondary px-1.5 py-0.5 text-[11.5px] text-muted-foreground">outside Cloudflare</span>}
                  <span className="mt-0.5 block text-muted-foreground">{item.what}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <footer className="fixed inset-x-0 bottom-0 border-t bg-background/85 px-4 pt-3.5 pb-[calc(12px+env(safe-area-inset-bottom))] backdrop-blur-lg sm:px-6">
        {showStarters && starters.length > 0 && !typing && (
          <div className="-mx-4 mb-2.5 flex snap-x scroll-px-4 gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:hidden [&::-webkit-scrollbar]:hidden" aria-label="Questions to start with">
            {starters.map((starter) => (
              <Button key={starter} variant="outline" className="h-10 flex-none snap-start rounded-full bg-card px-4 text-[14px] font-medium" onClick={() => void send(starter)}>
                {starter}
              </Button>
            ))}
          </div>
        )}
        <form
          onSubmit={submit}
          autoComplete="off"
          className="mx-auto flex max-w-[672px] gap-1.5 rounded-[14px] border border-input bg-card p-[5px] shadow-[0_1px_2px_rgb(23_32_57/0.04),0_8px_24px_rgb(23_32_57/0.06)] transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/20 dark:shadow-none"
        >
          {canListen && (
            <Button type="button" variant={mood === "listening" ? "default" : "ghost"} className="size-11 text-muted-foreground data-[variant=default]:text-primary-foreground" aria-label="Ask by voice" onClick={() => { started.current = true; voice.unlock(); listen(); }}>
              <Mic className="size-5" />
            </Button>
          )}
          <label htmlFor="question" className="sr-only">
            Your question
          </label>
          <Input
            id="question"
            value={draft}
            onFocus={() => focusBox(true)}
            onBlur={() => focusBox(false)}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about the work"
            maxLength={config.maxMessageChars}
            enterKeyHint="send"
            className="h-11 flex-1 border-0 bg-transparent px-2.5 text-base shadow-none focus-visible:border-0 focus-visible:ring-0 md:text-base dark:bg-transparent"
          />
          <Button type="submit" disabled={busy || !draft.trim()} className="size-11" aria-label="Send">
            <ArrowRight className="size-5" />
          </Button>
        </form>
        <div className={cn("mx-auto mt-1.5 flex min-h-10 max-w-[672px] items-center justify-between gap-3", typing && "max-sm:hidden")}>
          <button type="button" onClick={openContact} className="py-3 font-heading text-[14.5px] leading-tight font-semibold underline decoration-1 underline-offset-[5px] hover:text-link">
            Talk to the real {config.firstName}
          </button>
          <span className="flex gap-3 sm:gap-4">
            {config.links.map((link) => (
              <a key={link.url} href={link.url} target="_blank" rel="noopener" className="py-3 text-[13px] text-dim hover:text-foreground">
                {link.label}
              </a>
            ))}
          </span>
        </div>
      </footer>
      </div>

      <Toaster dark={dark} position="top-center" />
      <ContactDialog
        open={contactOpen}
        onOpenChange={setContactOpen}
        firstName={config.firstName}
        questions={asked.current}
        onSent={(message, requestId) => {
          if (requestId && !requestRef.current) {
            requestRef.current = { id: requestId, state: "pending" };
            setRequest(requestRef.current);
          }
          started.current = true;
          voice.unlock();
          const next: Reply = { kind: "contact", text: message, sources: [], openContact: false };
          setQuestion("");
          setReply(next);
          void say(next);
        }}
      />
    </>
  );
}
