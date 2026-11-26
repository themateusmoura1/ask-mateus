import { useState, type FormEvent } from "react";
import { Title } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { enterCode, type SessionInfo } from "@/lib/api";

/**
 * The gate. Nothing about the person is in the front end: the name and the
 * notes come from the server, and only after a valid code.
 */
export function Gate({ session, message, onEntered }: { session: SessionInfo; message?: string; onEntered: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState(message ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const result = await enterCode(code);
    setBusy(false);
    if (result.ok) onEntered();
    else setError(result.error);
  }

  return (
    <main className="grid min-h-dvh place-items-center p-4 sm:p-6">
      <Card className="w-full max-w-[460px] rounded-2xl py-0 shadow-[0_1px_2px_rgb(23_32_57/0.04),0_8px_24px_rgb(23_32_57/0.06)] dark:shadow-none">
        <CardContent className="p-7 sm:p-10">
          <Title text={session.title} className="mb-3.5 text-[clamp(40px,9vw,60px)] leading-none whitespace-nowrap" />
          <p className="mb-6 text-[16.5px] leading-relaxed text-muted-foreground">This assistant is private. Enter the access code you were given.</p>
          <form onSubmit={submit} className="flex gap-2.5" autoComplete="off">
            <label htmlFor="code" className="sr-only">
              Access code
            </label>
            <Input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Access code"
              maxLength={80}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              required
              aria-invalid={Boolean(error)}
              aria-describedby="code-error"
              className="h-[50px] flex-1 bg-background px-4 text-base font-medium tracking-wider uppercase placeholder:font-normal placeholder:tracking-normal placeholder:normal-case md:text-base"
            />
            <Button type="submit" disabled={busy} className="h-[50px] px-6 font-heading text-[15px] font-semibold">
              Enter
            </Button>
          </form>
          <p id="code-error" role="alert" className="mt-2.5 min-h-[1.5em] text-sm text-destructive">
            {error}
          </p>
          <p className="mt-4 border-t pt-4 text-[13.5px] leading-relaxed text-dim">
            Conversations here are logged and {session.owner} can read them: your questions, the answers and which code you used. Logs are deleted after{" "}
            {session.retentionDays} days. Your IP address is not stored.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
