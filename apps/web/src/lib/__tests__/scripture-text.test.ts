import { describe, expect, it } from "vitest";
import { splitScriptureText } from "../scripture-text";

describe("scripture text from flattened ProPresenter text boxes", () => {
  it.each([
    ["John 3:16\nKJV\nFor God so loved the world", "For God so loved the world", "John 3:16 KJV"],
    ["John 3:16 KJV For God so loved the world", "For God so loved the world", "John 3:16 KJV"],
    ["John 3:16\nNew King James Version\nFor God so loved the world", "For God so loved the world", "John 3:16 New King James Version"],
    ["John 3:16 (KJV)\nFor God so loved the world", "For God so loved the world", "John 3:16 (KJV)"],
    ["For God so loved the world\nJohn 3:16 NIV", "For God so loved the world", "John 3:16 NIV"],
    ["Psalm 23:1 · KJV The LORD is my shepherd", "The LORD is my shepherd", "Psalm 23:1 · KJV"],
    ["Love is patient\n1 Corinthians 13:4–7 (ESV)", "Love is patient", "1 Corinthians 13:4–7 (ESV)"],
    ["Rom. 8:1\nThere is therefore now no condemnation\nNKJV", "There is therefore now no condemnation", "Rom. 8:1 · NKJV"],
  ])("separates %s without losing verse text", (input, text, reference) => {
    expect(splitScriptureText(input)).toEqual({ text, reference });
  });
  it("finds the reference in metadata without putting slide notes into the verse", () => {
    expect(splitScriptureText("The LORD is my shepherd", ["Psalm 23:1 · KJV", "Sunday scripture"]))
      .toEqual({ text: "The LORD is my shepherd", reference: "Psalm 23:1 · KJV" });
  });
  it("leaves lyrics, numbers, and references in the middle of prose untouched", () => {
    for (const text of ["Amazing grace\nHow sweet the sound", "Verse 1\nAmazing grace", "Read John 3:16 before the next verse."]) {
      expect(splitScriptureText(text)).toEqual({ text, reference: "" });
    }
  });
});
