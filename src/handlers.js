const ts = require('typescript');

function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }

  return node;
}

function isTestFile(path) {
  return /(?:^|[/\\])(?:__tests__|tests?|specs?)(?:[/\\])|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(
    path,
  );
}

// Bind a single in-memory file: import symbols and local shadowing are enough
// to recognize NgRx APIs. Event identity comes from VS Code's reference provider.
function createClassifier(fileName, text, direction = 'subscribers') {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const options = {
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
  };

  const host = ts.createCompilerHost(options);

  host.getSourceFile = (name) => (name === fileName ? source : undefined);
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();

  function importedSymbol(expression) {
    expression = unwrap(expression);
    const qualified = ts.isQualifiedName(expression);
    const namespace = ts.isPropertyAccessExpression(expression) || qualified;
    const identifier = qualified ? expression.left : namespace ? expression.expression : expression;

    if (!ts.isIdentifier(identifier)) {
      return;
    }

    const symbol = checker.getSymbolAtLocation(identifier);
    const declaration = symbol?.declarations?.[0];
    let api;
    let importDeclaration;

    if (namespace && declaration && ts.isNamespaceImport(declaration)) {
      api = qualified ? expression.right.text : expression.name.text;
      importDeclaration = declaration.parent.parent;
    } else if (!namespace && declaration && ts.isImportSpecifier(declaration)) {
      api = (declaration.propertyName || declaration.name).text;
      importDeclaration = declaration.parent.parent.parent;
    }

    if (
      !importDeclaration ||
      !ts.isImportDeclaration(importDeclaration) ||
      !ts.isStringLiteral(importDeclaration.moduleSpecifier)
    ) {
      return;
    }

    const module = importDeclaration.moduleSpecifier.text;

    return { module, name: api };
  }

  function isApi(expression, module, name) {
    const imported = importedSymbol(expression);

    return imported?.module === module && imported.name === name;
  }

  function importedApi(expression) {
    if (isApi(expression, '@ngrx/effects', 'ofType')) {
      return 'Effect';
    }

    if (isApi(expression, '@ngrx/store', 'on')) {
      return 'Reducer';
    }
  }

  function label(node, kind) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        (ts.isVariableDeclaration(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isFunctionDeclaration(parent)) &&
        parent.name
      ) {
        return parent.name.getText(source);
      }
    }

    return kind === 'Dispatch'
      ? 'Store.dispatch'
      : kind === 'Effect'
        ? 'ofType handler'
        : 'on handler';
  }

  function effectScope(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        ts.isCallExpression(parent) &&
        isApi(parent.expression, '@ngrx/effects', 'createEffect')
      ) {
        return parent.getStart(source);
      }
    }
  }

  const registrations = [];

  if (direction === 'publishers') {
    collectPublishers(source, checker, isApi, importedSymbol, (event, kind) => {
      const token = ts.isPropertyAccessExpression(event) ? event.name : event;

      if (!ts.isIdentifier(token)) {
        return;
      }

      registrations.push({
        kind,
        eventName: event.getText(source),
        effectStart: effectScope(event),
        name: label(event, kind),
        start: token.getStart(source),
        end: token.getEnd(),
        registrationStart: token.getStart(source),
        preview: event.parent.getText(source).replace(/\s+/g, ' ').slice(0, 180),
      });
    });
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const kind = importedApi(node.expression);

      if (kind) {
        const args = kind === 'Reducer' ? node.arguments.slice(0, -1) : node.arguments;

        for (const argument of args) {
          const event = unwrap(argument);

          // Only an action identifier or property is a static event registration.
          // Calls, spread arrays, and strings require separate data-flow analysis.
          if (!ts.isIdentifier(event) && !ts.isPropertyAccessExpression(event)) {
            continue;
          }

          const token = ts.isPropertyAccessExpression(event) ? event.name : event;

          registrations.push({
            kind,
            effectStart: effectScope(node),
            name: label(node, kind),
            start: token.getStart(source),
            end: token.getEnd(),
            registrationStart: node.getStart(source),
            preview: node.getText(source).replace(/\s+/g, ' ').slice(0, 180),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  if (direction === 'subscribers') {
    visit(source);
  }

  const classify = (offset) =>
    registrations.find((entry) => offset >= entry.start && offset < entry.end);

  classify.registrations = registrations;

  return classify;
}

// Follow only recognizable output paths. Being inside createEffect is not
// sufficient: tap callbacks, discarded values, and overwritten map outputs
// must not be reported as publishers.
function collectPublishers(source, checker, isApi, importedSymbol, add) {
  function declaration(expression) {
    expression = unwrap(expression);
    const token = ts.isPropertyAccessExpression(expression) ? expression.name : expression;

    return checker.getSymbolAtLocation(token)?.declarations?.[0];
  }

  function constant(expression, depth = 0) {
    expression = unwrap(expression);

    if (depth > 30 || !ts.isIdentifier(expression)) {
      return expression;
    }

    const decl = declaration(expression);

    if (
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      decl.parent.flags & ts.NodeFlags.Const
    ) {
      return constant(decl.initializer, depth + 1);
    }

    return expression;
  }

  function isStore(expression, depth = 0) {
    if (depth > 20) {
      return false;
    }

    expression = unwrap(expression);

    if (
      ts.isCallExpression(expression) &&
      isApi(expression.expression, '@angular/core', 'inject') &&
      expression.arguments[0] &&
      isApi(expression.arguments[0], '@ngrx/store', 'Store')
    ) {
      return true;
    }

    const decl = declaration(expression);

    if (!decl) {
      return false;
    }

    if (
      decl.type &&
      ts.isTypeReferenceNode(decl.type) &&
      isApi(decl.type.typeName, '@ngrx/store', 'Store')
    ) {
      return true;
    }

    return !!decl.initializer && isStore(decl.initializer, depth + 1);
  }

  function returned(fn) {
    fn = constant(fn);

    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) {
      return [];
    }

    if (!ts.isBlock(fn.body)) {
      return [fn.body];
    }

    const results = [];

    function visit(node) {
      if (ts.isFunctionLike(node)) {
        return;
      }

      if (ts.isReturnStatement(node) && node.expression) {
        results.push(node.expression);
      } else {
        ts.forEachChild(node, visit);
      }
    }

    visit(fn.body);

    return results;
  }

  function value(expression, depth = 0) {
    if (depth > 40) {
      return [];
    }

    expression = constant(expression);

    if (ts.isConditionalExpression(expression)) {
      return [...value(expression.whenTrue, depth + 1), ...value(expression.whenFalse, depth + 1)];
    }

    if (ts.isCallExpression(expression)) {
      const callee = unwrap(expression.expression);

      if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) {
        return [callee];
      }
    }

    return [];
  }

  const preserving = new Set([
    'tap',
    'filter',
    'take',
    'takeLast',
    'takeUntil',
    'takeWhile',
    'skip',
    'skipLast',
    'skipUntil',
    'skipWhile',
    'distinct',
    'distinctUntilChanged',
    'distinctUntilKeyChanged',
    'debounce',
    'debounceTime',
    'throttle',
    'throttleTime',
    'audit',
    'auditTime',
    'sample',
    'sampleTime',
    'delay',
    'delayWhen',
    'finalize',
    'share',
    'shareReplay',
    'retry',
    'repeat',
    'observeOn',
    'subscribeOn',
  ]);

  function rxName(expression) {
    const imported = importedSymbol(expression);

    return imported && ['rxjs', 'rxjs/operators'].includes(imported.module)
      ? imported.name
      : undefined;
  }

  function observable(expression, depth = 0, operatorLimit) {
    if (depth > 40) {
      return [];
    }

    expression = constant(expression);

    if (ts.isConditionalExpression(expression)) {
      return [
        ...observable(expression.whenTrue, depth + 1),
        ...observable(expression.whenFalse, depth + 1),
      ];
    }

    // Arrays are ObservableInput values for flattening operators and from().
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.flatMap((entry) => value(entry, depth + 1));
    }

    if (!ts.isCallExpression(expression)) {
      return [];
    }

    const callee = unwrap(expression.expression);
    const name = rxName(callee);

    if (name === 'of') {
      return expression.arguments.flatMap((arg) => value(arg, depth + 1));
    }

    if (name === 'from' && expression.arguments[0]) {
      const input = constant(expression.arguments[0]);

      return ts.isArrayLiteralExpression(input) ? observable(input, depth + 1) : [];
    }

    if (name === 'defer' && expression.arguments[0]) {
      return returned(expression.arguments[0]).flatMap((arg) => observable(arg, depth + 1));
    }

    if (['merge', 'concat', 'race'].includes(name)) {
      return expression.arguments.flatMap((arg) => observable(arg, depth + 1));
    }

    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'pipe') {
      return [];
    }

    let outputs = observable(callee.expression, depth + 1);

    for (const operator of expression.arguments.slice(0, operatorLimit)) {
      const op = constant(operator);

      if (!ts.isCallExpression(op)) {
        outputs = [];
        continue;
      }

      const opName = rxName(op.expression);
      const first = op.arguments[0];

      if (opName === 'map' && first) {
        const callback = constant(first);
        const returns = returned(callback);

        outputs = returns.flatMap((result) => {
          const parameter = callback.parameters?.[0]?.name;
          const unwrapped = unwrap(result);
          const identity =
            parameter &&
            ts.isIdentifier(unwrapped) &&
            checker.getSymbolAtLocation(unwrapped) === checker.getSymbolAtLocation(parameter);

          return identity ? outputs : value(result, depth + 1);
        });
      } else if (opName === 'mapTo' && first) {
        outputs = value(first, depth + 1);
      } else if (['switchMap', 'mergeMap', 'concatMap', 'exhaustMap'].includes(opName) && first) {
        // A result selector changes the emitted value and is not analyzed.
        outputs =
          op.arguments.length > 1 && !ts.isNumericLiteral(op.arguments[1])
            ? []
            : returned(first).flatMap((result) => observable(result, depth + 1));
      } else if (opName === 'catchError' && first) {
        outputs = [
          ...outputs,
          ...returned(first).flatMap((result) => observable(result, depth + 1)),
        ];
      } else if (['startWith', 'endWith'].includes(opName)) {
        outputs = [...outputs, ...op.arguments.flatMap((arg) => value(arg, depth + 1))];
      } else if (!preserving.has(opName)) {
        // Unknown/custom transformations can change the output type.
        outputs = [];
      }
    }

    return outputs;
  }

  function dispatchedValue(expression) {
    const direct = value(expression);

    if (direct.length) {
      return direct;
    }

    const input = constant(expression);

    if (!ts.isIdentifier(input)) {
      return [];
    }

    const parameter = declaration(input);

    if (!parameter || !ts.isParameter(parameter)) {
      return [];
    }

    const callback = parameter.parent;

    if (callback.parameters[0] !== parameter) {
      return [];
    }

    const operator = callback.parent;

    if (
      !ts.isCallExpression(operator) ||
      rxName(operator.expression) !== 'tap' ||
      operator.arguments[0] !== callback
    ) {
      return [];
    }

    const pipe = operator.parent;

    if (
      !ts.isCallExpression(pipe) ||
      !ts.isPropertyAccessExpression(pipe.expression) ||
      pipe.expression.name.text !== 'pipe'
    ) {
      return [];
    }

    // Reassigned callback parameters no longer reliably represent the input.
    let written = false;

    function checkWrites(node) {
      if (
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ts.isPrefixUnaryExpression(node) ||
        ts.isPostfixUnaryExpression(node)
      ) {
        const target = unwrap(node.left || node.operand);

        if (checker.getSymbolAtLocation(target) === checker.getSymbolAtLocation(parameter.name)) {
          written = true;
        }
      }

      ts.forEachChild(node, checkWrites);
    }

    checkWrites(callback.body);

    return written ? [] : observable(pipe, 0, pipe.arguments.indexOf(operator));
  }

  function dispatches(effect) {
    if (!effect.arguments[1]) {
      return true;
    }

    const config = constant(effect.arguments[1]);

    if (!ts.isObjectLiteralExpression(config)) {
      return false;
    }

    let enabled = true;

    for (const prop of config.properties) {
      if (ts.isSpreadAssignment(prop) || ts.isComputedPropertyName(prop.name)) {
        return false;
      }

      if (prop.name?.getText(source).replace(/['"]/g, '') === 'dispatch') {
        if (!ts.isPropertyAssignment(prop)) {
          return false;
        }

        enabled = constant(prop.initializer).kind === ts.SyntaxKind.TrueKeyword;
      }
    }

    return enabled;
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);

      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'dispatch' &&
        isStore(callee.expression) &&
        node.arguments[0]
      ) {
        const input = constant(node.arguments[0]);
        const values =
          ts.isArrowFunction(input) || ts.isFunctionExpression(input) ? returned(input) : [input];

        for (const event of values.flatMap((arg) => dispatchedValue(arg))) {
          add(event, 'Dispatch');
        }
      }

      if (isApi(callee, '@ngrx/effects', 'createEffect') && node.arguments[0] && dispatches(node)) {
        for (const event of returned(node.arguments[0]).flatMap((arg) => observable(arg))) {
          add(event, 'Effect');
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
}

module.exports = { createClassifier, isTestFile };
