const ts = require('typescript');
const storePackages = new Set(['@evst/store']);

function unwrap(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node))
  ) {
    node = node.expression;
  }

  return node;
}

// Resolve API bindings, not spellings: unrelated state/view/on functions and
// shadowed callback parameters must not be mistaken for Sugar APIs.
function sugarAnalysis(checker) {
  function declaration(node) {
    if (!node) {
      return;
    }

    let symbol = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(node) ? node.name : node,
    );

    if (symbol?.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }

    return symbol?.valueDeclaration || symbol?.declarations?.[0];
  }

  function value(node, seen = new Set()) {
    node = unwrap(node);

    if (!node || seen.has(node)) {
      return node;
    }

    seen.add(node);

    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const decl = declaration(node);

      if (decl?.initializer) {
        return value(decl.initializer, seen);
      }
    }

    return node;
  }

  function isApi(node, name) {
    node = unwrap(node);

    if (!node) {
      return false;
    }

    const identifier = ts.isPropertyAccessExpression(node) ? node.expression : node;
    const decl = checker.getSymbolAtLocation(identifier)?.declarations?.[0];

    if (decl && ts.isImportSpecifier(decl) && ts.isIdentifier(node)) {
      return (
        (decl.propertyName || decl.name).text === name &&
        storePackages.has(decl.parent.parent.parent.moduleSpecifier.text)
      );
    }

    if (decl && ts.isNamespaceImport(decl) && ts.isPropertyAccessExpression(node)) {
      return node.name.text === name && storePackages.has(decl.parent.parent.moduleSpecifier.text);
    }

    return false;
  }

  function stateChain(expression, seen = new Set()) {
    const node = value(expression);

    if (!node || seen.has(node) || !ts.isCallExpression(node)) {
      return;
    }

    const branch = new Set(seen).add(node);

    if (isApi(node.expression, 'state')) {
      return { base: node, steps: [] };
    }

    const callee = unwrap(node.expression);

    if (
      !ts.isPropertyAccessExpression(callee) ||
      !['on', 'withViews', 'withTasks'].includes(callee.name.text)
    ) {
      return;
    }

    const previous = stateChain(callee.expression, branch);

    return previous && { base: previous.base, steps: [...previous.steps, node] };
  }

  function taskInfo(node) {
    if (!node || !ts.isCallExpression(node)) {
      return;
    }

    const parameter = declaration(unwrap(node.expression));

    if (!parameter || !ts.isParameter(parameter)) {
      return;
    }

    const factory = parameter.parent;
    const collection = factory.parent;

    if (
      factory.parameters[0] !== parameter ||
      !ts.isCallExpression(collection) ||
      !isApi(collection.expression, 'tasks') ||
      collection.arguments[0] !== factory
    ) {
      return;
    }

    const callbackIndex = node.arguments.findIndex((arg) => {
      const resolved = value(arg);

      return resolved && (ts.isArrowFunction(resolved) || ts.isFunctionExpression(resolved));
    });

    if (callbackIndex < 0) {
      return;
    }

    return {
      callback: value(node.arguments[callbackIndex]),
      events: node.arguments.slice(0, callbackIndex),
      config: node.arguments[callbackIndex + 1],
    };
  }

  function isTaskPipe(node) {
    const parameter = declaration(node);

    if (!parameter || !ts.isParameter(parameter)) {
      return false;
    }

    const callback = parameter.parent;
    const info = taskInfo(callback.parent);

    return (
      !!info?.events.length && info.callback === callback && callback.parameters[0] === parameter
    );
  }

  return { declaration, value, isApi, stateChain, taskInfo, isTaskPipe };
}

module.exports = { sugarAnalysis };
