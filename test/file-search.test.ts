import { expect, test } from "bun:test";
import { matcher, searchText, snippet } from "../src/fileSearch";

// Highlights must agree with grep's -F / -i / -w / -E rules.
const plain = { caseSensitive: false, wholeWord: false, regex: false };

test("plain text is literal and case-insensitive by default", () => {
  const re = matcher("a.b (x)", plain)!;
  expect(searchText("A.B (X) here\nab x\n", re)).toEqual([{ line: 1, text: "A.B (X) here" }]);
});

test("whole word, case and regex options", () => {
  expect(searchText("rc1 rc10\nRC1\n", matcher("RC1", { ...plain, wholeWord: true, caseSensitive: true })!)).toEqual([
    { line: 2, text: "RC1" },
  ]);
  expect(searchText("rc10 only\n", matcher("rc1", { ...plain, wholeWord: true })!)).toEqual([]);
  expect(searchText("x = 42\nx = y\n", matcher("\\d+", { ...plain, regex: true })!)).toEqual([{ line: 1, text: "x = 42" }]);
  expect(matcher("(", { ...plain, regex: true })).toBeNull();
  expect(matcher("", plain)).toBeNull();
});

test("snippet centers on the match and marks it", () => {
  const re = matcher("needle", plain)!;
  const parts = snippet("a".repeat(300) + " needle " + "b".repeat(300), re, 60);
  expect(parts[0].text.startsWith("…")).toBe(true);
  expect(parts.find((p) => p.match)?.text).toBe("needle");
});
