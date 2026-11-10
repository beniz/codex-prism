// Check runtime exports in product libraries/stores, including consumers in tests,
// scripts, dynamic imports, and workers. Test-only use is reported, not rejected.
// Public types and UI component libraries are deliberately outside this check.
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const scripts = ts.sys.readDirectory(path.join(root, 'scripts'), ['.ts', '.tsx'], ['**/node_modules/**']);
const program = ts.createProgram([...parsed.fileNames, ...scripts], parsed.options);
const checker = program.getTypeChecker();
const canonical = symbol => symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
const files = program.getSourceFiles().filter(f => f.fileName.startsWith(root + '/') && !f.isDeclarationFile && !f.fileName.includes('/node_modules/'));
const exports = new Map();
for (const file of files) {
  if (!/\/src\/(lib|stores)\//.test(file.fileName) || /\.test\./.test(file.fileName)) continue;
  const module = checker.getSymbolAtLocation(file);
  if (!module) continue;
  for (const exported of checker.getExportsOfModule(module)) {
    const symbol = canonical(exported);
    if (!(symbol.flags & ts.SymbolFlags.Value)) continue;
    const declaration = symbol.valueDeclaration;
    if (!declaration || declaration.getSourceFile() !== file) continue;
    exports.set(symbol, { name: exported.name, file, declaration, product: false, test: false });
  }
}
for (const file of files) {
  const test = file.fileName.includes('/__tests__/') || /\.test\./.test(file.fileName);
  function visit(node) {
    if (ts.isIdentifier(node)) {
      const entry = exports.get(canonical(checker.getSymbolAtLocation(node)));
      // A declaration's own name is not a use. Internal references are legitimate
      // uses too: this check identifies dead helpers, not unnecessary `export`s.
      if (entry && node !== entry.declaration.name) entry[test ? 'test' : 'product'] = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}
let failures = 0;
const testOnly = [];
for (const entry of exports.values()) {
  if (entry.product) continue;
  const line = entry.file.getLineAndCharacterOfPosition(entry.declaration.getStart()).line + 1;
  const label = `${path.relative(root, entry.file.fileName)}:${line} ${entry.name}`;
  if (entry.test) testOnly.push(label);
  else { console.error(`Unused runtime export: ${label}`); failures++; }
}
if (testOnly.length) console.log(`Review test-only exports (not failures):\n${testOnly.join('\n')}`);
console.log(`Checked ${exports.size} runtime exports; ${failures} unused.`);
process.exitCode = failures ? 1 : 0;
