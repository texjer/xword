// Third-party embedding of published puzzles: the `/embed/[id]` frame ↔ host
// page protocol, and the snippet the Embed dialog hands out.
//
// The host side of the protocol lives in `public/embed.js` (plain script, no
// build step — it's served to other people's pages). Keep the message shape
// here and there in sync.

export type EmbedScheme = "auto" | "light" | "dark";

export interface EmbedOptions {
  scheme: EmbedScheme;
  /** Title bar (title + author). Hiding it is a member feature. */
  showTitle: boolean;
  /** The "Made with … / Open full puzzle" footer. Hiding it is a member feature. */
  showFooter: boolean;
}

/** Both hide flags need the puzzle's customize key (see lib/embedKey.ts). */
export function embedNeedsKey(options: EmbedOptions): boolean {
  return !options.showTitle || !options.showFooter;
}

export type EmbedMessage =
  | { event: "resize"; id: string; height: number }
  | { event: "progress"; id: string; filled: number; total: number }
  | { event: "solved"; id: string }
  /** Posted once the frame is listening for host messages (only when its
   * scheme is `auto`); embed.js answers with `scheme`. */
  | { event: "ready"; id: string };

/** Host page → frame. embed.js sends these; nothing else is expected. */
export type EmbedHostMessage = { event: "scheme"; scheme: "light" | "dark" };

/** Message `type` discriminator, so hosts can ignore everything else on the wire. */
export const EMBED_MESSAGE_TYPE = "crossword-embed";

/** Post to the host page when framed. No-op on a direct visit to /embed/... */
export function postEmbedMessage(message: EmbedMessage) {
  if (typeof window === "undefined" || window.parent === window) return;
  // Nothing sensitive crosses here (a height, a fill count), and the host's
  // origin is unknown by design, so "*" is the honest target.
  window.parent.postMessage({ type: EMBED_MESSAGE_TYPE, ...message }, "*");
}

export type EmbedSearchParams = {
  scheme?: string | string[];
  title?: string | string[];
  footer?: string | string[];
  k?: string | string[];
};

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Parse the embed route's search params into options (unknown values →
 * defaults). `keyValid` is whether the `k` param verified for this puzzle —
 * without it the hide flags are ignored, since anyone can type `footer=0`
 * into an iframe src.
 */
export function parseEmbedOptions(params: EmbedSearchParams, keyValid: boolean): EmbedOptions {
  const scheme = first(params.scheme);
  return {
    scheme: scheme === "light" || scheme === "dark" ? scheme : "auto",
    showTitle: !keyValid || first(params.title) !== "0",
    showFooter: !keyValid || first(params.footer) !== "0",
  };
}

/** The `k` search param, if any (verified separately by lib/embedKey.ts). */
export function embedKeyParam(params: EmbedSearchParams): string | undefined {
  return first(params.k);
}

/** The frame URL, with only the non-default options as params. `embedPath` is
 * the locale-prefixed `/embed/<id>` so the frame's labels match the UI locale.
 * `key` is the member's customize key; it's only included when a hide flag
 * needs it, so ordinary snippets don't carry it around. */
export function embedUrl(
  origin: string,
  embedPath: string,
  options: EmbedOptions,
  key?: string | null
): string {
  const url = new URL(embedPath, origin);
  if (options.scheme !== "auto") url.searchParams.set("scheme", options.scheme);
  if (!options.showTitle) url.searchParams.set("title", "0");
  if (!options.showFooter) url.searchParams.set("footer", "0");
  if (key && embedNeedsKey(options)) url.searchParams.set("k", key);
  return url.toString();
}

/**
 * Fallback iframe height for hosts that strip the resize script (many CMS
 * sanitizers do). Approximates the stacked layout — grid on top, clue lists
 * side by side below — since typical blog columns are narrower than the
 * side-by-side breakpoint. Once embed.js runs, it takes over from this.
 */
export function embedFallbackHeight(size: number): number {
  const gridPx = size <= 15 ? Math.min(72 * size, 544) : 27.2 * size;
  return Math.round(gridPx + 470);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The paste-ready snippet: iframe + resize script + a plain-HTML caption.
 * The caption is the one part a crawler attributes to the host page (framed
 * content is credited to us), so it carries the title, a link to the puzzle,
 * and the "made with" backlink. Turning the footer off drops the backlink from
 * the caption too — that's the attribution the member is opting out of — but
 * the title link stays, since it's the host page's own text.
 */
export function embedSnippet({
  origin,
  embedPath,
  puzzlePath,
  puzzleTitle,
  size,
  options,
  key,
  madeWith,
  siteName,
}: {
  origin: string;
  embedPath: string;
  puzzlePath: string;
  puzzleTitle: string;
  size: number;
  options: EmbedOptions;
  key?: string | null;
  /** Localized "Made with {{link}}" template. */
  madeWith: string;
  siteName: string;
}): string {
  const src = embedUrl(origin, embedPath, options, key);
  const title = escapeHtml(puzzleTitle);
  const caption = escapeHtml(madeWith).replace(
    "{{link}}",
    `<a href="${origin}/">${escapeHtml(siteName)}</a>`
  );
  const titleLink = `<a href="${origin}${puzzlePath}">${title}</a>`;
  return [
    `<iframe src="${src}" title="${title}" width="100%" height="${embedFallbackHeight(size)}" style="border:0;max-width:100%;display:block" loading="lazy" allow="clipboard-write"></iframe>`,
    `<script async src="${origin}/embed.js"></script>`,
    `<p style="font-size:0.85em;margin:0.5em 0 0">${options.showFooter ? `${titleLink} — ${caption}` : titleLink}</p>`,
  ].join("\n");
}
