import ts from "typescript";

function jsxAttribute(opening, name) {
  return opening.attributes.properties.find(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === name,
  );
}

function isAriaHidden(opening) {
  const attribute = jsxAttribute(opening, "aria-hidden");
  if (!attribute) return false;
  if (!attribute.initializer) return true;
  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text === "true";
  }
  return (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword
  );
}

function expressionCanNameControl(expression) {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text.trim().length > 0;
  }
  if (
    ts.isNumericLiteral(expression) ||
    ts.isTemplateExpression(expression) ||
    ts.isIdentifier(expression) ||
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression) ||
    ts.isCallExpression(expression)
  ) {
    return true;
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return expressionCanNameControl(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      expressionCanNameControl(expression.whenTrue) &&
      expressionCanNameControl(expression.whenFalse)
    );
  }
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return false;
    }
    if (
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return (
        expressionCanNameControl(expression.left) &&
        expressionCanNameControl(expression.right)
      );
    }
    return true;
  }
  if (ts.isJsxElement(expression)) {
    return jsxChildrenCanNameControl(expression.children);
  }
  if (ts.isJsxFragment(expression)) {
    return jsxChildrenCanNameControl(expression.children);
  }
  return false;
}

function jsxElementCanNameControl(element) {
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  if (isAriaHidden(opening)) return false;
  const alt = jsxAttribute(opening, "alt");
  if (alt?.initializer && ts.isStringLiteral(alt.initializer)) {
    return alt.initializer.text.trim().length > 0;
  }
  return ts.isJsxElement(element)
    ? jsxChildrenCanNameControl(element.children)
    : false;
}

function jsxChildrenCanNameControl(children) {
  return children.some((child) => {
    if (ts.isJsxText(child)) return child.text.trim().length > 0;
    if (ts.isJsxExpression(child)) {
      return child.expression
        ? expressionCanNameControl(child.expression)
        : false;
    }
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      return jsxElementCanNameControl(child);
    }
    return false;
  });
}

export function findAnonymousNativeButtons(source, filePath = "fixture.tsx") {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const lines = [];
  const visit = (node) => {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(sourceFile) === "button"
    ) {
      const opening = node.openingElement;
      const explicitlyNamed = ["aria-label", "aria-labelledby", "title"].some(
        (name) => Boolean(jsxAttribute(opening, name)),
      );
      const nameMayComeFromSpread = opening.attributes.properties.some(
        ts.isJsxSpreadAttribute,
      );
      if (
        !explicitlyNamed &&
        !nameMayComeFromSpread &&
        !jsxChildrenCanNameControl(node.children)
      ) {
        const location = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        lines.push(location.line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}
