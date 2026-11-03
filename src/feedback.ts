/** What Send Feedback may attach: never paths or document text, as issues are public. */
export interface FeedbackContext {
  version: string;
  window: string;
  view: string;
  fileType: string | null;
}

const TITLE_MAX = 80;
// GitHub turns away very long /issues/new URLs; keep the encoded body well below that.
const BODY_MAX = 6000;

export function feedbackTitle(text: string): string {
  const line = text.trim().split("\n")[0].replace(/^[-*•]\s*/, "").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

export function contextLines(ctx: FeedbackContext): string[] {
  return [
    `OpenMD ${ctx.version}`,
    `Window ${ctx.window}`,
    `View: ${ctx.view}${ctx.fileType ? ` (.${ctx.fileType} file)` : ""}`,
  ];
}

/** A prefilled "new issue" link for `repo` with the text and, optionally, the context. */
export function feedbackIssueUrl(repo: string, text: string, ctx: FeedbackContext | null): string {
  const details = ctx ? `\n\n---\n${contextLines(ctx).map((l) => `- ${l}`).join("\n")}` : "";
  let body = text.trim();
  while (encodeURIComponent(body + details).length > BODY_MAX) body = body.slice(0, -200);
  if (body.length < text.trim().length) body += "…\n\n_(cut to fit the link)_";
  const params = new URLSearchParams({ title: feedbackTitle(text), body: body + details });
  return `${repo}/issues/new?${params}`;
}
