import { describe, expect, test } from "bun:test";
import { localDocLinks, resolveLink, rewriteLinks } from "../src/docLinks";

// Publishing with linked documents rewrites links in place, so the scanner
// must find exactly the local .md links, and leave code and everything else.
describe("linked documents", () => {
  const md = [
    "# Readout",
    "See [findings](/r/FINDINGS.md) and [access](./ACCESS.md#who \"Access\").",
    "Also [web](https://x.dev/a.md), [anchor](#top), ![img](pic.md), [log](run.log).",
    "Inline `[not](code.md)` stays, [spaced](<my notes.md>) works.",
    "```",
    "[fenced](fenced.md)",
    "```",
    "[ref]: ../other/REF.md",
  ].join("\n");

  test("finds local markdown links only", () => {
    expect(localDocLinks(md)).toEqual([
      "/r/FINDINGS.md",
      "./ACCESS.md#who",
      "my notes.md",
      "../other/REF.md",
    ]);
  });

  test("rewrites them in place, keeping titles and everything else", () => {
    const urls = new Map([
      ["/r/FINDINGS.md", "https://p/1"],
      ["./ACCESS.md#who", "https://p/2"],
      ["my notes.md", "https://p/3"],
      ["../other/REF.md", "https://p/4"],
    ]);
    const out = rewriteLinks(md, urls);
    expect(out).toContain("[findings](https://p/1)");
    expect(out).toContain('[access](https://p/2 "Access")');
    expect(out).toContain("[spaced](https://p/3)");
    expect(out).toContain("[ref]: https://p/4");
    expect(out).toContain("`[not](code.md)`");
    expect(out).toContain("[fenced](fenced.md)");
    expect(out).toContain("![img](pic.md)");
  });

  test("resolves against the document's folder", () => {
    expect(resolveLink("/a/b", "./ACCESS.md#who")).toBe("/a/b/ACCESS.md");
    expect(resolveLink("/a/b", "../other/REF.md")).toBe("/a/other/REF.md");
    expect(resolveLink("/a/b", "my%20notes.md")).toBe("/a/b/my notes.md");
    expect(resolveLink(null, "x.md")).toBeNull();
    expect(resolveLink("/a", "bad%zz.md")).toBeNull();
  });
});

// Publishing uploads a document's local images and points them at the
// uploads; links and images must not be mixed up.
describe("local images", () => {
  test("found and rewritten, links and web images left alone", async () => {
    const { localImageRefs, rewriteImages, localDocLinks } = await import("../src/docLinks");
    const md = [
      "![shot](img/a.png) and ![web](https://x.dev/b.png) and ![data](data:image/png;base64,AA)",
      '<img src="img/c.png" alt="c"> and [doc](notes.md)',
      "`![code](img/x.png)`",
    ].join("\n");
    expect(localImageRefs(md)).toEqual(["img/a.png", "img/c.png"]);
    expect(localDocLinks(md)).toEqual(["notes.md"]);
    const out = rewriteImages(md, new Map([["img/a.png", "https://u/1"], ["img/c.png", "https://u/2"]]));
    expect(out).toContain("![shot](https://u/1)");
    expect(out).toContain('<img src="https://u/2" alt="c">');
    expect(out).toContain("[doc](notes.md)");
    expect(out).toContain("`![code](img/x.png)`");
  });
});
