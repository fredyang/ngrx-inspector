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
  const taskCollections = new WeakMap();
  const stateCollections = new WeakMap();

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
      !['on', 'handle', 'extraViews', 'withViews', 'withTasks'].includes(callee.name.text)
    ) {
      return;
    }

    const previous = stateChain(callee.expression, branch);

    return previous && { base: previous.base, steps: [...previous.steps, node] };
  }

  function returned(fn) {
    fn = value(fn);

    if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) {
      return;
    }

    if (!ts.isBlock(fn.body)) {
      return value(fn.body);
    }

    const returns = [];
    const visit = (node) => {
      if (ts.isFunctionLike(node)) {
        return;
      }

      if (ts.isReturnStatement(node)) {
        returns.push(node.expression);
      } else {
        ts.forEachChild(node, visit);
      }
    };

    visit(fn.body);

    return returns.length === 1 ? value(returns[0]) : undefined;
  }

  function objectValues(expression, seen = new Set()) {
    const object = value(expression);

    if (!object || seen.has(object) || !ts.isObjectLiteralExpression(object)) {
      return [];
    }

    const branch = new Set(seen).add(object);

    return object.properties.flatMap((property) => {
      if (ts.isSpreadAssignment(property)) {
        return objectValues(property.expression, branch);
      }

      return ts.isPropertyAssignment(property) ? [value(property.initializer)] : [];
    });
  }

  function collectionFor(factory, collections, matches) {
    if (collections.has(factory)) {
      return collections.get(factory);
    }

    let collection;
    const visit = (node) => {
      if (!collection && ts.isCallExpression(node) && matches(node)) {
        collection = node;

        return;
      }

      ts.forEachChild(node, visit);
    };

    visit(factory.getSourceFile());
    collections.set(factory, collection);

    return collection;
  }

  function taskCollection(factory) {
    return collectionFor(
      factory,
      taskCollections,
      (node) => isTaskCollection(node) && value(node.arguments[0]) === factory,
    );
  }

  function stateCollection(factory) {
    return collectionFor(
      factory,
      stateCollections,
      (node) =>
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'handle' &&
        value(node.arguments[0]) === factory &&
        !!stateChain(node),
    );
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
    const collection = taskCollection(factory);

    if (factory.parameters[0] !== parameter || !collection) {
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

  function isTaskCollection(node) {
    return (
      isApi(node.expression, 'tasks') ||
      (ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'handle' &&
        isApi(node.expression.expression, 'task'))
    );
  }

  function stateHandlerInfo(node) {
    if (!node || !ts.isCallExpression(node)) {
      return;
    }

    const callee = value(node.expression);
    const parameter = declaration(callee);

    if (!parameter || !ts.isParameter(parameter)) {
      return;
    }

    const build = parameter.parent;
    const handle = stateCollection(build);

    if (
      (!ts.isArrowFunction(build) && !ts.isFunctionExpression(build)) ||
      build.parameters[0] !== parameter ||
      !handle ||
      !stateChain(handle)
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

    return { events: node.arguments.slice(0, callbackIndex) };
  }

  function stateHandlers(steps) {
    return steps.flatMap((step) => {
      if (step.expression.name.text === 'on') {
        return [step];
      }

      return step.expression.name.text === 'handle'
        ? objectValues(returned(step.arguments[0])).filter(
            (handler) => ts.isCallExpression(handler) && !!stateHandlerInfo(handler),
          )
        : [];
    });
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

  return {
    declaration,
    value,
    isApi,
    stateChain,
    taskInfo,
    stateHandlerInfo,
    stateHandlers,
    isTaskPipe,
  };
}

module.exports = { sugarAnalysis };
