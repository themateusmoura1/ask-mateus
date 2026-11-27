import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Assistant } from "@/components/Assistant";
import { ThemeToggle, useTheme } from "@/components/common";
import { Gate } from "@/components/Gate";
import { enterLink, getConfig, getSession, personalLink, type Config, type SessionInfo } from "@/lib/api";
import "./index.css";

function App() {
  const theme = useTheme();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [message, setMessage] = useState("");

  const loadConfig = useCallback(async () => {
    const result = await getConfig();
    if (result && "error" in result) {
      setConfig(null);
      setMessage(result.error);
    } else {
      setConfig(result);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      // Opened through a personal link: enter with it, then tidy the address bar.
      const link = personalLink();
      let failed = "";
      if (link) {
        const entered = await enterLink(link);
        if (!entered.ok) failed = entered.error;
      }
      if (location.pathname !== "/") history.replaceState(null, "", `/${location.hash}`);
      const info = await getSession();
      if (info.authed) await loadConfig();
      else if (failed) setMessage(failed);
      setSession(info);
    })();
  }, [loadConfig]);

  useEffect(() => {
    document.title = config?.title ?? session?.title ?? "Ask";
  }, [config, session]);

  if (!session) return null;

  if (!config) {
    return (
      <>
        <ThemeToggle dark={theme.dark} onToggle={theme.toggle} className="fixed top-3.5 right-4 sm:top-5 sm:right-6" />
        <Gate session={session} message={message} onEntered={loadConfig} />
      </>
    );
  }

  return (
    <Assistant
      config={config}
      dark={theme.dark}
      onToggleTheme={theme.toggle}
      onSignedOut={() => {
        setConfig(null);
        setMessage("Your access has ended. Enter a code to continue.");
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
