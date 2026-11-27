import { StrictMode, useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeToggle, useTheme } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import "./index.css";

// The owner's page: approve requests, manage access codes, read the logs.
// The token stays in this tab's memory and is sent as a header.

interface ContactRequest { id: string; createdAt: string; status: string; label: string; name: string; email: string; reason: string; questions: string[]; draftReply: string }
interface Code { id: string; label: string; note: string; variant?: string; createdAt: string; expiresAt?: string; revoked: boolean; uses: number; lastUsedAt?: string; linkName?: string }
interface Activity {
  days: number;
  retentionDays: number;
  failedCodes: number;
  perCode: Record<string, { label: string; entries: number; messages: number; costUsd: number; voiceChars: number; lastSeen: string }>;
  perDay: Record<string, { messages: number; inputTokens: number; outputTokens: number; costUsd: number; voiceChars: number }>;
  conversations: { sid: string; label: string; startedAt: string; turns: { at: string; question: string; answer: string; outcome: string; sources: string[]; costUsd: number }[] }[];
  unanswered: { at: string; label: string; question: string }[];
  safety: { at: string; what: string; label?: string; question?: string }[];
  errors: { at: string; where: string; message: string }[];
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "");
const usd = (n: number) => `$${n.toFixed(4)}`;

function useApi(token: string) {
  return useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(res.status === 401 ? "Wrong token." : res.status === 404 ? "Admin is off: no ADMIN_TOKEN is set on the server." : data.error || "That didn't work. Try again.");
      }
      return res.json();
    },
    [token],
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="mb-4 text-sm leading-relaxed text-dim">{children}</p>;
const Heading = ({ children }: { children: ReactNode }) => <h3 className="mt-6 mb-2 text-[13px] tracking-normal text-dim">{children}</h3>;
const Panel = ({ children }: { children: ReactNode }) => (
  <Card className="rounded-2xl py-0 shadow-[0_1px_2px_rgb(23_32_57/0.04),0_8px_24px_rgb(23_32_57/0.06)] dark:shadow-none">
    <CardContent className="p-5 sm:p-6">{children}</CardContent>
  </Card>
);

function DataTable({ head, rows, numeric = [] }: { head: string[]; rows: (string | number)[][]; numeric?: number[] }) {
  if (!rows.length) return <Note>Nothing yet.</Note>;
  return (
    <Panel>
      <Table>
        <TableHeader>
          <TableRow>
            {head.map((h, i) => (
              <TableHead key={h} className={numeric.includes(i) ? "text-right" : ""}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, r) => (
            <TableRow key={r}>
              {row.map((cell, i) => (
                <TableCell key={i} className={numeric.includes(i) ? "text-right tabular-nums" : "whitespace-normal break-words"}>{cell}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

function Requests({ api }: { api: ReturnType<typeof useApi> }) {
  const [requests, setRequests] = useState<ContactRequest[]>([]);
  const load = useCallback(() => api<{ requests: ContactRequest[] }>("/api/admin/requests").then((d) => setRequests(d.requests)), [api]);
  useEffect(() => void load(), [load]);
  const decide = async (id: string, decision: string) => {
    await api(`/api/admin/requests/${id}`, { decision });
    await load();
  };
  return (
    <div className="grid gap-4">
      <Note>Nothing has been sent to any of these people. Approve, reply from your own email, then mark as sent.</Note>
      {!requests.length && <Note>No requests yet.</Note>}
      {requests.map((r) => (
        <Panel key={r.id}>
          <Badge variant={r.status === "pending" ? "default" : "secondary"} className="mb-3">{r.status}</Badge>
          <h2 className="text-[22px] leading-tight tracking-[-0.03em] break-words">{r.name}</h2>
          <p className="mt-1 mb-3 text-[13.5px] break-words text-dim">{r.email} · came in with "{r.label}" · {when(r.createdAt)}</p>
          <p className="break-words whitespace-pre-wrap">{r.reason}</p>
          {r.questions.length > 0 && (<><Heading>They asked the assistant</Heading><p className="break-words whitespace-pre-wrap text-muted-foreground">{r.questions.join("\n")}</p></>)}
          <Heading>Draft reply, for you to edit and send</Heading>
          <p className="break-words whitespace-pre-wrap text-muted-foreground">{r.draftReply}</p>
          <div className="mt-4 flex flex-wrap gap-2.5">
            {r.status === "pending" && (<><Button className="h-10 px-4" onClick={() => decide(r.id, "approved")}>Approve</Button><Button variant="outline" className="h-10 px-4" onClick={() => decide(r.id, "declined")}>Decline</Button></>)}
            {r.status === "approved" && (
              <>
                <Button asChild className="h-10 px-4">
                  <a href={`mailto:${encodeURIComponent(r.email)}?subject=${encodeURIComponent("Re: your message on my site")}&body=${encodeURIComponent(r.draftReply)}`}>Open reply in email</a>
                </Button>
                <Button variant="outline" className="h-10 px-4" onClick={() => decide(r.id, "sent")}>Mark as sent</Button>
              </>
            )}
          </div>
        </Panel>
      ))}
    </div>
  );
}

function Codes({ api }: { api: ReturnType<typeof useApi> }) {
  const [codes, setCodes] = useState<Code[]>([]);
  const [variants, setVariants] = useState<string[]>([]);
  const [fresh, setFresh] = useState<{ code: string; label: string } | null>(null);
  const [freshLink, setFreshLink] = useState<{ link: string; label: string } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<{ codes: Code[]; variants?: string[] }>("/api/admin/codes").then((d) => {
        setCodes(d.codes);
        setVariants(d.variants ?? []);
      }), [api]);
  useEffect(() => void load(), [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError("");
    try {
      const made = await api<{ code: string; record: Code }>("/api/admin/codes", Object.fromEntries(new FormData(form)));
      setFresh({ code: made.code, label: made.record.label });
      form.reset();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const field = "h-11 bg-background px-3.5 text-base md:text-base";
  return (
    <div className="grid gap-4">
      {fresh && (
        <Panel>
          <Heading>New code for {fresh.label}. Copy it now: it is not stored and won't be shown again.</Heading>
          <p className="rounded-lg bg-secondary p-3.5 font-heading text-[22px] font-semibold tracking-wider select-all">{fresh.code}</p>
        </Panel>
      )}
      {freshLink && (
        <Panel>
          <Heading>Personal link for {freshLink.label}. Copy it now: it is not stored and won't be shown again.</Heading>
          <p className="rounded-lg bg-secondary p-3.5 font-heading text-[17px] font-semibold break-all select-all">{freshLink.link}</p>
          <Note>Opening it signs the visitor in with this code. Anyone who has the link can use it, so send it only to the person it is for.</Note>
        </Panel>
      )}
      <Panel>
        <form onSubmit={create} className="grid items-end gap-4 sm:grid-cols-2">
          <div className="grid gap-2"><Label htmlFor="code-label">Label, used in the greeting</Label><Input id="code-label" name="label" placeholder="Acme" required className={field} /></div>
          <div className="grid gap-2"><Label htmlFor="code-expires">Expires (optional)</Label><Input id="code-expires" name="expiresAt" type="date" className={field} /></div>
          <div className="grid gap-2 sm:col-span-2"><Label htmlFor="code-note">Note for the assistant (optional)</Label><Input id="code-note" name="note" placeholder="Hiring for a solutions role, interested in agent platforms" className={field} /></div>
          {variants.length > 0 && (
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="code-variant">Demo variant (optional). Available: {variants.join(", ")}</Label>
              <Input id="code-variant" name="variant" placeholder="Leave empty for the standard demo" className={field} />
            </div>
          )}
          <div className="flex items-center gap-3 sm:col-span-2"><Button type="submit" className="h-11 px-5 font-heading font-semibold">Create code</Button><span role="alert" className="text-sm text-destructive">{error}</span></div>
        </form>
      </Panel>
      {codes.map((c) => {
        const expired = Boolean(c.expiresAt && c.expiresAt < new Date().toISOString());
        const state = c.revoked ? "revoked" : expired ? "expired" : "active";
        return (
          <Panel key={c.id}>
            <Badge variant={state === "active" ? "default" : "secondary"} className="mb-3">{state}</Badge>
            <h2 className="text-[22px] leading-tight tracking-[-0.03em] break-words">{c.label}</h2>
            <p className="mt-1 text-[13.5px] text-dim">used {c.uses} times · last {when(c.lastUsedAt) || "never"} · created {when(c.createdAt)}{c.expiresAt ? ` · expires ${when(c.expiresAt)}` : ""}</p>
            {c.variant && (<><Heading>Demo variant</Heading><p className="text-muted-foreground">{c.variant}</p></>)}
            {c.note && (<><Heading>Note</Heading><p className="text-muted-foreground">{c.note}</p></>)}
            {c.linkName && (<><Heading>Personal link</Heading><p className="text-muted-foreground">Has one, starting /{c.linkName}-. The rest is not stored. Make a new link to replace it.</p></>)}
            {state === "active" && (
              <div className="mt-4 flex flex-wrap gap-2.5">
                <Button
                  variant="outline"
                  className="h-10 px-4"
                  onClick={async () => {
                    setError("");
                    try {
                      const made = await api<{ link: string }>(`/api/admin/codes/${c.id}/link`, {});
                      setFreshLink({ link: made.link, label: c.label });
                      window.scrollTo({ top: 0 });
                      await load();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  {c.linkName ? "Replace personal link" : "Create personal link"}
                </Button>
                <Button variant="outline" className="h-10 px-4" onClick={async () => { await api(`/api/admin/codes/${c.id}/revoke`, {}); await load(); }}>Revoke</Button>
              </div>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

function Logs({ api, view }: { api: ReturnType<typeof useApi>; view: "activity" | "conversations" | "unanswered" | "safety" }) {
  const [a, setA] = useState<Activity | null>(null);
  useEffect(() => void api<Activity>("/api/admin/activity?days=30").then(setA), [api]);
  if (!a) return <Note>Loading</Note>;

  if (view === "activity") {
    return (
      <div>
        <Note>Last {a.days} days. Logs are deleted after {a.retentionDays} days. Wrong codes tried: {a.failedCodes}.</Note>
        <Heading>Per access code</Heading>
        <DataTable head={["Code", "Entries", "Messages", "Spend", "Voice chars", "Last seen"]} numeric={[1, 2, 3, 4]} rows={Object.values(a.perCode).map((c) => [c.label, c.entries, c.messages, usd(c.costUsd), c.voiceChars, when(c.lastSeen)])} />
        <Heading>Per day</Heading>
        <DataTable head={["Day", "Messages", "Tokens in", "Tokens out", "Spend", "Voice chars"]} numeric={[1, 2, 3, 4, 5]} rows={Object.entries(a.perDay).sort((x, y) => y[0].localeCompare(x[0])).map(([day, d]) => [day, d.messages, d.inputTokens, d.outputTokens, usd(d.costUsd), d.voiceChars])} />
      </div>
    );
  }
  if (view === "conversations") {
    return (
      <div className="grid gap-4">
        {!a.conversations.length && <Note>No conversations yet.</Note>}
        {a.conversations.map((c) => (
          <Panel key={c.sid}>
            <h2 className="text-[22px] leading-tight tracking-[-0.03em]">{c.label}</h2>
            <p className="mt-1 text-[13.5px] text-dim">{when(c.startedAt)} · {c.turns.length} messages</p>
            {c.turns.map((t) => (
              <div key={t.at + t.question} className="mt-4">
                <p className="font-semibold break-words">{t.question}</p>
                <p className="mt-0.5 break-words whitespace-pre-wrap text-muted-foreground">{t.answer}</p>
                <p className="mt-1 text-[13px] text-dim">{t.outcome}{t.sources.length ? ` · sources: ${t.sources.join(", ")}` : ""} · {usd(t.costUsd)}</p>
              </div>
            ))}
          </Panel>
        ))}
      </div>
    );
  }
  if (view === "unanswered") {
    return (
      <div>
        <Note>Questions the notes could not answer. These are what to add to the knowledge base next.</Note>
        <DataTable head={["When", "Code", "Question"]} rows={a.unanswered.map((u) => [when(u.at), u.label, u.question])} />
      </div>
    );
  }
  return (
    <div>
      <Heading>Safety events</Heading>
      <DataTable head={["When", "What", "Code", "Question"]} rows={a.safety.map((s) => [when(s.at), s.what, s.label ?? "", s.question ?? ""])} />
      <Heading>Errors</Heading>
      <DataTable head={["When", "Where", "Message"]} rows={a.errors.map((e) => [when(e.at), e.where, e.message])} />
    </div>
  );
}

function Admin() {
  const theme = useTheme();
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const api = useApi(token);

  async function open(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const res = await fetch("/api/admin/codes", { headers: { authorization: `Bearer ${draft}` } });
      if (res.status === 401) throw new Error("Wrong token.");
      if (res.status === 404) throw new Error("Admin is off: no ADMIN_TOKEN is set on the server.");
      setToken(draft);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="mx-auto max-w-[880px] px-4 pt-10 pb-16 sm:px-6 sm:pt-12">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="mb-2 font-heading text-[13px] font-semibold text-dim">Owner only</p>
          <h1 className="text-[clamp(36px,6vw,52px)] leading-none">Admin</h1>
        </div>
        <ThemeToggle dark={theme.dark} onToggle={theme.toggle} />
      </div>

      {!token ? (
        <form onSubmit={open} className="grid max-w-[520px] gap-2">
          <Label htmlFor="token">Admin token</Label>
          <div className="flex gap-2.5">
            <Input id="token" type="password" autoComplete="current-password" required value={draft} onChange={(e) => setDraft(e.target.value)} className="h-11 flex-1 bg-card px-3.5 text-base md:text-base" />
            <Button type="submit" className="h-11 px-5 font-heading font-semibold">Open</Button>
          </div>
          <p role="alert" className="min-h-[1.25em] text-sm text-destructive">{error}</p>
        </form>
      ) : (
        <Tabs defaultValue="requests">
          <TabsList className="mb-5 h-auto flex-wrap justify-start gap-1">
            <TabsTrigger value="requests" className="h-9 px-3">Requests</TabsTrigger>
            <TabsTrigger value="codes" className="h-9 px-3">Access codes</TabsTrigger>
            <TabsTrigger value="activity" className="h-9 px-3">Activity</TabsTrigger>
            <TabsTrigger value="conversations" className="h-9 px-3">Conversations</TabsTrigger>
            <TabsTrigger value="unanswered" className="h-9 px-3">Unanswered</TabsTrigger>
            <TabsTrigger value="safety" className="h-9 px-3">Safety and errors</TabsTrigger>
          </TabsList>
          <TabsContent value="requests"><Requests api={api} /></TabsContent>
          <TabsContent value="codes"><Codes api={api} /></TabsContent>
          {(["activity", "conversations", "unanswered", "safety"] as const).map((view) => (
            <TabsContent key={view} value={view}><Logs api={api} view={view} /></TabsContent>
          ))}
        </Tabs>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Admin />
  </StrictMode>,
);
