// Third-party embedding of published puzzles: the `/embed/[id]` frame ↔ host
// page protocol, and the snippet the Embed dialog hands out.
//
// The host side of the protocol lives in `public/embed.js` (plain script, no
// build step — it's served to other people's pages). Keep the message shape
// here and there in sync.

export type EmbedScheme = "auto" | "light" | "dark";

export interface EmbedOptions {
  scheme: EmbedScheme;
  /**
   * Puzzle scale: a multiplier on the frame's root font-size, so the grid,
   * the clue lists and the type all grow or shrink together. Free, unlike the
   * hide flags — it changes the size of our own branding, not whether it's
   * there.
   */
  scale: number;
  /** Title bar (title + author). Hiding it is a member feature. */
  showTitle: boolean;
  /**
   * The "Made with …" caption under the iframe. Hiding it is a member
   * feature. The caption is plain HTML in the host page (see `embedCaption`),
   * not part of the frame, so this never reaches the frame URL — the member
   * simply gets a snippet without the line.
   */
  showFooter: boolean;
}

export const EMBED_SCALE_DEFAULT = 1;
export const EMBED_SCALE_MIN = 0.7;
export const EMBED_SCALE_MAX = 1.6;

/**
 * Scale is a URL param on a frame anyone can host, so it can arrive as
 * anything. Bad values fall back to 1 rather than erroring, and the range is
 * bounded because the grid's own cell cap is in `rem`: below ~0.7 the numbers
 * in the squares stop being legible, and much above 1.6 a 15x15 no longer
 * fits a laptop viewport at all. Two decimals — a URL carrying
 * `scale=1.1500000000000001` is nobody's idea of a snippet.
 */
export function clampEmbedScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return EMBED_SCALE_DEFAULT;
  return Math.round(Math.min(EMBED_SCALE_MAX, Math.max(EMBED_SCALE_MIN, value)) * 100) / 100;
}

/** Hiding the title bar needs the puzzle's customize key (see lib/embedKey.ts). */
export function embedNeedsKey(options: EmbedOptions): boolean {
  return !options.showTitle;
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
  scale?: string | string[];
  title?: string | string[];
  k?: string | string[];
};

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Parse the embed route's search params into options (unknown values →
 * defaults). `keyValid` is whether the `k` param verified for this puzzle —
 * without it the hide flag is ignored, since anyone can type `title=0`
 * into an iframe src. `showFooter` is a snippet-side option with no frame
 * counterpart, so it's always true here.
 */
export function parseEmbedOptions(params: EmbedSearchParams, keyValid: boolean): EmbedOptions {
  const scheme = first(params.scheme);
  return {
    scheme: scheme === "light" || scheme === "dark" ? scheme : "auto",
    scale: clampEmbedScale(Number(first(params.scale))),
    showTitle: !keyValid || first(params.title) !== "0",
    showFooter: true,
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
  if (options.scale !== EMBED_SCALE_DEFAULT) url.searchParams.set("scale", String(options.scale));
  if (!options.showTitle) url.searchParams.set("title", "0");
  if (key && embedNeedsKey(options)) url.searchParams.set("k", key);
  return url.toString();
}

/**
 * Fallback iframe height for hosts that strip the resize script (many CMS
 * sanitizers do). Approximates the stacked layout — grid on top, clue lists
 * side by side below — since typical blog columns are narrower than the
 * side-by-side breakpoint. Once embed.js runs, it takes over from this.
 */
export function embedFallbackHeight(size: number, scale = EMBED_SCALE_DEFAULT): number {
  const gridPx = size <= 15 ? Math.min(72 * size, 544) : 27.2 * size;
  // Everything in the frame is sized in `rem`, so a scale multiplies the whole
  // estimate, not just the grid.
  return Math.round((gridPx + 470) * scale);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inputs for the caption under the iframe. */
export interface EmbedCaptionInput {
  origin: string;
  options: EmbedOptions;
  /** Localized "Made with {{link}}" template. */
  madeWith: string;
  siteName: string;
}

/**
 * The credit under the iframe, as plain HTML in the host page: one centred
 * "Made with <site>" line. It used to be a footer inside the frame; it lives
 * in the host's HTML because that's the only place a crawler credits to the
 * host page (framed content is credited to us). Everything is `inherit`
 * (font, colour) with a little opacity for the muted look, so it follows the
 * host's own dark mode without knowing how that's switched — and it's a
 * single centred line on purpose: a two-sided flex row was the first cut,
 * and host stylesheets that reach into `p` broke its alignment. The way
 * back to the full puzzle is the frame's own Open button.
 * Turning the credit off is a member feature; the caption is then omitted.
 */
export function embedCaption({ origin, options, madeWith, siteName }: EmbedCaptionInput): string {
  if (!options.showFooter) return "";
  const credit = escapeHtml(madeWith).replace(
    "{{link}}",
    `<a href="${origin}/" style="color:inherit;text-decoration:none;font-weight:600">${escapeHtml(siteName)}</a>`
  );
  return `<p style="margin:0.5em 0 0;text-align:center;font-size:0.8em;line-height:1.4;color:inherit;opacity:0.75">${credit}</p>`;
}

/**
 * The paste-ready snippet: iframe + resize/scheme script + the caption.
 */
export function embedSnippet({
  origin,
  embedPath,
  puzzleTitle,
  size,
  key,
  ...caption
}: EmbedCaptionInput & {
  embedPath: string;
  puzzleTitle: string;
  size: number;
  key?: string | null;
}): string {
  const src = embedUrl(origin, embedPath, caption.options, key);
  const title = escapeHtml(puzzleTitle);
  return [
    `<iframe src="${src}" title="${title}" width="100%" height="${embedFallbackHeight(size, caption.options.scale)}" style="border:0;max-width:100%;display:block" loading="lazy" allow="clipboard-write"></iframe>`,
    `<script async src="${origin}/embed.js"></script>`,
    embedCaption({ origin, ...caption }),
  ]
    .filter(Boolean)
    .join("\n");
}
