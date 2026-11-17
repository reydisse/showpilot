import ts from 'typescript';
export function scan(source) {
 const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
 const sites = []; const unsafe = [];
 function visit(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'prepare') {
   const arg = node.arguments[0];
   if (arg && ts.isTemplateExpression(arg)) for (const span of arg.templateSpans) sites.push(span.expression.getText(file));
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
   if (/LIKE\s+\?/i.test(node.text) && !/ESCAPE/i.test(node.text)) unsafe.push(node.text);
  }
  ts.forEachChild(node, visit);
 }
 visit(file); return { sites, unsafe };
}
