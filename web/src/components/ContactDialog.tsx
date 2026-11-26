import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sendContact } from "@/lib/api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  firstName: string;
  questions: string[];
  onSent: (message: string, requestId?: string) => void;
}

/** The only place the site does more than answer. The request waits for approval. */
export function ContactDialog({ open, onOpenChange, firstName, questions, onSent }: Props) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError("");
    const result = await sendContact({ ...Object.fromEntries(new FormData(form)), questions: questions.slice(-5) });
    setBusy(false);
    if (result.ok) {
      form.reset();
      onOpenChange(false);
      onSent(result.message, result.requestId);
    } else {
      setError(result.error);
    }
  }

  const field = "h-11 bg-background px-3.5 text-base md:text-base";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 rounded-2xl p-6 sm:max-w-[480px] sm:p-7">
        <DialogHeader className="mb-5 gap-2 text-left">
          <DialogTitle className="font-heading text-[26px] leading-tight font-semibold tracking-[-0.04em]">Talk to the real {firstName}</DialogTitle>
          <DialogDescription className="text-[15px] leading-relaxed">
            The assistant can't speak for {firstName} or book anything. Your request is read by {firstName}, who replies by email.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="contact-name">Your name</Label>
            <Input id="contact-name" name="name" maxLength={80} autoComplete="name" required className={field} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="contact-email">Your email</Label>
            <Input id="contact-email" name="email" type="email" maxLength={160} autoComplete="email" required className={field} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="contact-reason">Why you'd like to talk</Label>
            <Textarea id="contact-reason" name="reason" rows={4} maxLength={1000} required className="bg-background px-3.5 py-3 text-base md:text-base" />
          </div>
          {/* Hidden field. People leave it empty, form-filling bots do not. */}
          <div className="absolute -left-[9999px] h-0 overflow-hidden" aria-hidden="true">
            <label>
              Website
              <input name="website" type="text" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          <p role="alert" className="min-h-[1.25em] text-sm text-destructive">
            {error}
          </p>
          <DialogFooter className="gap-2.5">
            <Button type="button" variant="outline" className="h-11 px-5" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} className="h-11 px-5 font-heading font-semibold">
              {busy ? "Sending" : "Send request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
