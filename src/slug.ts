/**
 * Heading anchors the way GitHub makes them, so in-page links written for
 * GitHub (`[RC1](#rc1-the-item-is-dropped)`) work in OpenMD and on pages it
 * publishes: lowercase, punctuation dropped (letters, numbers, `-` and `_`
 * kept), each space a `-`, and a repeated heading gets `-1`, `-2`, ….
 */
export function githubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** A slug function that numbers repeats, for one document's headings in order. */
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = githubSlug(text);
    let slug = base;
    while (seen.has(slug)) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      slug = `${base}-${n}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}
