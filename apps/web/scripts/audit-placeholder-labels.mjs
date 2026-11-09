// Diagnostic only: spread helpers and unreachable components require manual review.
// Pair with compiled browser checks; this scan does not prove accessible names.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ts = createRequire(`${root}/package.json`)("typescript");
const files = execFileSync("rg", ["--files", `${root}/src`], {
  encoding: "utf8",
})
  .split("\n")
  .filter((path) => path.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(path));
const unresolved = [];
let checked = 0;
for (const path of files) {
  const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    ),
    labels = new Set();
  function prop(node, name) {
    return node.attributes?.properties.find(
      (p) => ts.isJsxAttribute(p) && p.name.getText(source) === name,
    );
  }
  function visitLabels(node) {
    if (
      ts.isJsxOpeningElement(node) &&
      node.tagName.getText(source) === "label"
    ) {
      const value = prop(node, "htmlFor")?.initializer?.getText(source);
      if (value) labels.add(value);
    }
    ts.forEachChild(node, visitLabels);
  }
  visitLabels(source);
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (
        ["input", "textarea", "select", "Input", "Textarea"].includes(tag) &&
        prop(node, "placeholder")
      ) {
        checked++;
        let labelled = !!(
          prop(node, "aria-label") || prop(node, "aria-labelledby")
        );
        const id = prop(node, "id")?.initializer?.getText(source);
        if (id && labels.has(id)) labelled = true;
        for (let parent = node.parent; parent; parent = parent.parent)
          if (
            ts.isJsxElement(parent) &&
            parent.openingElement.tagName.getText(source) === "label"
          )
            labelled = true;
        if (!labelled)
          unresolved.push({
            file: path.slice(root.length + 1),
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
            tag,
            spread: node.attributes.properties.some(ts.isJsxSpreadAttribute),
            placeholder: prop(node, "placeholder").initializer?.getText(source),
          });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
console.log(JSON.stringify({ checked, unresolved }, null, 2));
