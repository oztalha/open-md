import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import { REPO_URL } from "../links";
import { contextLines, feedbackIssueUrl } from "../feedback";
import type { FeedbackContext } from "../feedback";

const CONTEXT_KEY = "feedbackAttachContext";

/**
 * Help → Send Feedback…: write what should change, and Send opens a GitHub
 * issue with it filled in, to review and submit there. Nothing is sent from
 * the app itself.
 */
export function FeedbackDialog() {
  const open = useStore((s) => s.feedbackOpen);
  return open ? <Feedback /> : null;
}

function currentContext(version: string): FeedbackContext {
  const s = useStore.getState();
  const doc = s.focusedDoc();
  const name = doc?.path ?? doc?.remote?.path ?? doc?.title ?? "";
  const ext = /\.([\w]+)$/.exec(name)?.[1]?.toLowerCase() ?? null;
  return {
    version,
    window: `${window.innerWidth}×${window.innerHeight}`,
    view: s.activeLeaf().mode,
    fileType: doc ? ext : null,
  };
}

function Feedback() {
  const close = () => useStore.getState().setFeedbackOpen(false);
  const [text, setText] = useState("");
  const [version, setVersion] = useState("");
  const [attach, setAttach] = useState(() => localStorage.getItem(CONTEXT_KEY) !== "0");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((err) => setError(String(err)));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const ctx = currentContext(version);
  const send = async () => {
    if (!text.trim()) return;
    try {
      await openUrl(feedbackIssueUrl(REPO_URL, text, attach ? ctx : null));
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="settings-backdrop" onClick={close}>
      <div className="remote-prompt feedback-dialog" onClick={(event) => event.stopPropagation()}>
        <span className="remote-prompt-label">Send Feedback</span>
        <textarea
          className="remote-prompt-input feedback-text"
          placeholder={"What should change? For example:\n• Remember the split ratio per file\n• Search inside published pages"}
          value={text}
          autoFocus
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.metaKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <p className="publish-status feedback-hint">
          Send opens a new issue on GitHub with this filled in; review it and submit it there. Issues are public.
        </p>
        <label className="publish-asnew">
          <input
            type="checkbox"
            checked={attach}
            onChange={(event) => {
              setAttach(event.target.checked);
              localStorage.setItem(CONTEXT_KEY, event.target.checked ? "1" : "0");
            }}
          />
          Include {contextLines(ctx).join(", ")}
        </label>

        {error && <p className="publish-status rb-error">{error}</p>}

        <div className="remote-prompt-actions">
          <span className="rb-where" />
          <button className="remote-prompt-cancel" onClick={close}>
            Cancel
          </button>
          <button className="remote-prompt-open" onClick={() => void send()} disabled={!text.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
