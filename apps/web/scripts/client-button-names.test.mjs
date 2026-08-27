import assert from "node:assert/strict";
import test from "node:test";
import { findAnonymousNativeButtons } from "./client-button-names.mjs";

function anonymousLines(children, attributes = "") {
  return findAnonymousNativeButtons(
    `<button ${attributes}>${children}</button>`,
  );
}

test("rejects an icon-only native button", () => {
  assert.deepEqual(anonymousLines("<X />"), [1]);
});

test("accepts explicit and visible accessible names", () => {
  assert.deepEqual(anonymousLines("<X />", 'aria-label="Close"'), []);
  assert.deepEqual(anonymousLines("<X />", 'aria-labelledby="close-label"'), []);
  assert.deepEqual(anonymousLines("<X />", 'title="Close"'), []);
  assert.deepEqual(anonymousLines("<X /> Close"), []);
  assert.deepEqual(anonymousLines('<img alt="Close" />'), []);
});

test("accepts total dynamic labels and rejects labels that can disappear", () => {
  assert.deepEqual(anonymousLines('{name ?? "Fallback"}'), []);
  assert.deepEqual(anonymousLines('{name || "Fallback"}'), []);
  assert.deepEqual(anonymousLines('{loading ? "Loading" : "Save"}'), []);
  assert.deepEqual(anonymousLines('{loading ? <Spinner /> : "Save"}'), [1]);
  assert.deepEqual(anonymousLines('{enabled && "Disable"}'), [1]);
});

test("does not guess about attributes supplied by a spread", () => {
  assert.deepEqual(anonymousLines("<X />", "{...buttonProps}"), []);
});
