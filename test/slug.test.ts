import { expect, test } from "bun:test";
import { githubSlug, slugger } from "../src/slug";

// In-page links written for GitHub must find their heading in OpenMD too.
test("headings slug like GitHub's anchors", () => {
  expect(githubSlug("RC1 The item is dropped after something else")).toBe("rc1-the-item-is-dropped-after-something-else");
  expect(githubSlug("What's new? (v2.0)")).toBe("whats-new-v20");
  expect(githubSlug("Café & crème_brûlée")).toBe("café--crème_brûlée");
  const slug = slugger();
  expect([slug("Notes"), slug("Notes"), slug("Notes-1"), slug("Notes")]).toEqual(["notes", "notes-1", "notes-1-1", "notes-2"]);
});
