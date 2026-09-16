const ts = require('typescript');

// Keep only the latest workspace snapshot. Compare text, not Map identity, so
// unsaved edits, additions, and deletions invalidate the compiler together.
let cachedProgram;
let cachedFiles;
let cachedOptions;

function selectorProject(fileName) {
  const config = ts.findConfigFile(fileName.slice(0, fileName.lastIndexOf('/')), ts.sys.fileExists);

  if (!config) {
    return { options: {} };
  }

  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  );

  return { directory: config.slice(0, config.lastIndexOf('/')), options: parsed?.options || {} };
}

function selectorProgram(files, compilerOptions) {
  const optionsKey = JSON.stringify(compilerOptions);

  if (
    cachedOptions === optionsKey &&
    cachedFiles?.size === files.size &&
    [...files].every(([name, text]) => cachedFiles.get(name) === text)
  ) {
    return cachedProgram;
  }

  const options = {
    ...compilerOptions,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noLib: true,
    skipLibCheck: true,
  };

  const host = ts.createCompilerHost(options);

  host.readFile = (name) => files.get(name);
  host.fileExists = (name) => files.has(name);
  host.getSourceFile = (name, languageVersion) => {
    if (!files.has(name)) {
      return undefined;
    }

    return ts.createSourceFile(name, files.get(name), languageVersion, true);
  };

  const program = ts.createProgram([...files.keys()], options, host);

  cachedOptions = optionsKey;
  cachedFiles = new Map(files);
  cachedProgram = program;

  return program;
}

// Use compiler symbols so aliases and same-named exports stay distinct.
function inspectSelector(files, fileName, offset, compilerOptions = {}) {
  const program = selectorProgram(files, compilerOptions);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(fileName);

  if (!source) {
    return;
  }

  const walk = (node, visit) => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };

  const declaration = (node) => {
    let symbol = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(node) ? node.name : node,
    );

    if (symbol?.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }

    return symbol?.valueDeclaration || symbol?.declarations?.[0];
  };

  const unwrap = (node) => {
    while (
      node &&
      (ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node))
    ) {
      node = node.expression;
    }

    return node;
  };

  const value = (node, seen = new Set()) => {
    node = unwrap(node);

    if (!node || seen.has(node)) {
      return node;
    }

    seen.add(node);

    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const declarationNode = declaration(node);

      if (declarationNode?.initializer) {
        return value(declarationNode.initializer, seen);
      }

      if (declarationNode && ts.isFunctionDeclaration(declarationNode)) {
        return declarationNode;
      }
    }

    return node;
  };

  const callName = (node) =>
    ts.isCallExpression(node) ? node.expression.getText().split('.').pop() : '';

  // Follow factory returns without executing parameter-dependent code.
  const selectorValue = (node, seen = new Set()) => {
    node = value(node);

    if (!node || seen.has(node)) {
      return undefined;
    }

    const branch = new Set(seen).add(node);

    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      if (!node.body) {
        return undefined;
      }

      if (!ts.isBlock(node.body)) {
        return selectorValue(node.body, branch);
      }

      const returns = [];
      const visit = (child) => {
        if (ts.isFunctionLike(child)) {
          return;
        }

        if (ts.isReturnStatement(child)) {
          returns.push(child.expression);
        } else {
          ts.forEachChild(child, visit);
        }
      };

      visit(node.body);

      return returns.length === 1 ? selectorValue(returns[0], branch) : undefined;
    }

    if (
      ts.isCallExpression(node) &&
      !['createSelector', 'createFeatureSelector', 'getSelectors'].includes(callName(node))
    ) {
      const target = value(node.expression);

      if (target !== node.expression) {
        return selectorValue(target, branch);
      }
    }

    return node;
  };

  const location = (node) => ({
    fileName: node.getSourceFile().fileName,
    start: node.getStart(),
    end: node.getEnd(),
  });

  const property = (node, name) =>
    node.properties?.find(
      (propertyNode) =>
        (propertyNode.name && ts.isComputedPropertyName(propertyNode.name)
          ? literal(propertyNode.name.expression)
          : propertyNode.name?.getText().replace(/['"]/g, '')) === name,
    );

  const propertyValue = (propertyNode) =>
    propertyNode && (propertyNode.initializer || propertyNode.name);

  const literal = (node) => {
    node = value(node);

    return node && ts.isStringLiteralLike(node) ? node.text : undefined;
  };

  let selected;

  walk(source, (node) => {
    if (ts.isIdentifier(node) && node.getStart() <= offset && offset < node.getEnd()) {
      selected = node;
    }
  });

  if (!selected) {
    return;
  }

  const root = declaration(selected);

  if (!root) {
    return;
  }

  const features = [];

  for (const sourceFile of program.getSourceFiles()) {
    walk(sourceFile, (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const name = literal(propertyValue(property(node, 'name')));
        const reducer = propertyValue(property(node, 'reducer'));

        if (name && reducer) {
          features.push({ name, reducer });
        }
      }

      if (ts.isCallExpression(node) && ['forFeature', 'provideState'].includes(callName(node))) {
        const name = literal(node.arguments[0]);

        if (name && node.arguments[1]) {
          features.push({ name, reducer: node.arguments[1] });
        }
      }
    });
  }

  function trace(declarationNode, ancestors = new Set()) {
    if (!declarationNode || ancestors.has(declarationNode)) {
      return {
        tree: { label: 'Cycle or unresolved selector dependency' },
        paths: [],
      };
    }

    const branch = new Set(ancestors).add(declarationNode);
    let initializer = ts.isFunctionDeclaration(declarationNode)
      ? declarationNode
      : declarationNode.initializer;

    if (ts.isBindingElement(declarationNode)) {
      initializer = declarationNode.parent.parent.initializer;
    }

    initializer = initializer && selectorValue(initializer);
    const tree = {
      label: declarationNode.name?.getText() || 'Selector',
      kind: 'Selector',
      ...location(declarationNode),
      children: [],
    };

    if (!initializer) {
      tree.children.push({ label: 'Unsupported selector declaration' });

      return { tree, paths: [] };
    }

    let entitySelector;

    if (ts.isPropertyAccessExpression(initializer)) {
      const selectors = value(initializer.expression);

      if (selectors && callName(selectors) === 'getSelectors') {
        entitySelector = initializer.name.text;
        initializer = selectors;
      }
    }

    if (ts.isBindingElement(declarationNode)) {
      entitySelector = (declarationNode.propertyName || declarationNode.name).getText();
    }

    const name = callName(initializer);

    if (name === 'createFeatureSelector') {
      const key = literal(initializer.arguments[0]);

      return { tree, paths: key ? [[key]] : [], supported: true, exact: true };
    }

    if (!['createSelector', 'getSelectors'].includes(name)) {
      tree.children.push({
        label: 'Unsupported selector construction; dependency tracing stops here',
      });

      return { tree, paths: [] };
    }

    const args = [...initializer.arguments];
    const projector = name === 'createSelector' ? value(args.pop()) : undefined;
    const inputs = args.flatMap((arg) =>
      ts.isArrayLiteralExpression(arg) ? [...arg.elements] : [arg],
    );

    const traced = inputs.map((input) => {
      input = unwrap(input);

      return trace(declaration(ts.isCallExpression(input) ? input.expression : input), branch);
    });

    tree.children.push(...traced.map((result) => result.tree));
    let paths = traced.flatMap((result) => result.paths);

    if (name === 'getSelectors' && entitySelector) {
      const fields = {
        selectEntities: ['entities'],
        selectIds: ['ids'],
        selectAll: ['ids', 'entities'],
        selectTotal: ['ids'],
      };

      const selectedFields = fields[entitySelector];

      if (selectedFields) {
        paths = paths.flatMap((path) => selectedFields.map((field) => [...path, field]));
      }
    }

    let exact =
      name === 'getSelectors' && entitySelector !== 'selectAll' && entitySelector !== 'selectTotal';

    // A direct state projection narrows the reducer branch. Other projectors
    // conservatively retain all input branches.
    if (projector && ts.isArrowFunction(projector) && projector.parameters.length === 1) {
      let body = unwrap(projector.body);
      const fields = [];

      while (body && ts.isPropertyAccessExpression(body)) {
        fields.unshift(body.name.text);
        body = body.expression;
      }

      if (
        body?.getText() === projector.parameters[0].name.getText() &&
        traced.every((result) => result.exact)
      ) {
        exact = true;
        paths = paths.map((path) => [...path, ...fields]);
      }
    }

    return { tree, paths, supported: true, exact };
  }

  const result = trace(root);

  if (!result.supported) {
    return;
  }

  const compact = (tree) => {
    tree.children?.forEach(compact);

    if (!tree.children?.length) {
      delete tree.children;
    }
  };

  compact(result.tree);
  result.tree.inspected = true;
  const reducers = new Map();

  // Only report writes we can resolve, rather than every handler in a slice.
  function affects(handler, path) {
    const callback = value(handler.arguments.at(-1));

    if (!callback || !callback.parameters || !callback.body) {
      return false;
    }

    const state = callback.parameters[0]?.name;

    const isState = (node) =>
      node && state && ts.isIdentifier(node) && declaration(node) === declaration(state);

    function writes(expression, fields) {
      const node = unwrap(expression);

      if (!node || isState(node)) {
        return false;
      }

      if (ts.isConditionalExpression(node)) {
        return writes(node.whenTrue, fields) || writes(node.whenFalse, fields);
      }

      if (ts.isObjectLiteralExpression(node)) {
        if (!fields.length) {
          return true;
        }

        const propertyNode = property(node, fields[0]);

        if (propertyNode) {
          const assigned = unwrap(propertyValue(propertyNode));

          if (
            ts.isPropertyAccessExpression(assigned) &&
            isState(assigned.expression) &&
            assigned.name.text === fields[0]
          ) {
            return false;
          }

          return fields.length === 1 || writes(assigned, fields.slice(1));
        }

        const spreads = node.properties.filter(ts.isSpreadAssignment);

        return (
          spreads.length === 0 ||
          spreads.some(
            (propertyNode) =>
              !isState(unwrap(propertyNode.expression)) &&
              writes(value(propertyNode.expression), fields),
          )
        );
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const adapter = value(node.expression.expression);
        const methods = [
          'addOne',
          'addMany',
          'setOne',
          'setMany',
          'setAll',
          'removeOne',
          'removeMany',
          'removeAll',
          'updateOne',
          'updateMany',
          'upsertOne',
          'upsertMany',
          'mapOne',
          'map',
        ];

        if (
          adapter &&
          callName(adapter) === 'createEntityAdapter' &&
          methods.includes(callName(node))
        ) {
          return !fields.length || ['ids', 'entities'].includes(fields[0]);
        }
      }

      const resolved = value(node);

      return resolved !== node && writes(resolved, fields);
    }

    if (!ts.isBlock(callback.body)) {
      return writes(callback.body, path);
    }

    let matched = false;

    const visit = (node) => {
      if (ts.isFunctionLike(node)) {
        return;
      }

      if (ts.isReturnStatement(node)) {
        matched ||= writes(node.expression, path);
      } else {
        ts.forEachChild(node, visit);
      }
    };

    visit(callback.body);

    return matched;
  }

  function collect(expression, path, seen = new Set()) {
    const node = value(expression);

    if (!node || seen.has(node)) {
      return;
    }

    const branch = new Set(seen).add(node);

    if (callName(node) === 'createReducer') {
      const key = `${node.getSourceFile().fileName}:${node.getStart()}`;
      const declarationNode = declaration(expression);
      const children = node.arguments
        .slice(1)
        .map((argument) => value(argument))
        .filter((handler) => handler && callName(handler) === 'on')
        .filter((handler) => affects(handler, path))
        .map((handler) => ({
          label: `on(${handler.arguments
            .slice(0, -1)
            .map((action) => action.getText())
            .join(', ')})`,
          kind: 'Reducer',
          ...location(handler),
        }));

      if (!children.length) {
        return;
      }

      const previous = reducers.get(key)?.children || [];

      reducers.set(key, {
        label: declarationNode?.name?.getText() || 'Reducer',
        kind: 'Reducer',
        children: [
          ...new Map([...previous, ...children].map((child) => [child.start, child])).values(),
        ],
      });

      return;
    }

    if (ts.isObjectLiteralExpression(node)) {
      const entries = path.length ? [property(node, path[0])].filter(Boolean) : node.properties;

      entries.forEach((propertyNode) =>
        collect(propertyValue(propertyNode), path.slice(1), branch),
      );

      return;
    }

    if (callName(node) === 'combineReducers') {
      collect(node.arguments[0], path, branch);

      return;
    }

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      walk(node.body, (child) => {
        if (callName(child) === 'combineReducers') {
          collect(child, path, branch);
        }
      });
    }
  }

  for (const path of result.paths) {
    for (const feature of features) {
      if (feature.name === path[0]) {
        collect(feature.reducer, path.slice(1));
      }
    }
  }

  const usages = [];

  for (const sourceFile of program.getSourceFiles()) {
    walk(sourceFile, (node) => {
      if (!ts.isIdentifier(node) || node === root.name || declaration(node) !== root) {
        return;
      }

      let context = node;

      for (let parent = node.parent; parent; parent = parent.parent) {
        if (
          ts.isImportDeclaration(parent) ||
          ts.isExportDeclaration(parent) ||
          ts.isTypeNode(parent)
        ) {
          return;
        }

        if (ts.isStatement(parent)) {
          context = parent;
          break;
        }
      }

      const label = context.getText().replace(/\s+/g, ' ').trim();

      usages.push({
        label: label.length > 160 ? `${label.slice(0, 157)}...` : label,
        kind: 'Usage',
        ...location(node),
        inspected: node === selected,
      });
    });
  }

  usages.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.start - b.start);

  return {
    id: `${root.getSourceFile().fileName}:${root.getStart()}`,
    name: selected.text,
    groups: [
      { label: 'Selector tree', showCount: false, children: [result.tree] },
      {
        label: 'State dependencies',
        children: [...new Set(result.paths.map((path) => path.join('.')))].map((label) => ({
          label,
        })),
      },
      {
        label: 'Directly affecting reducer blocks',
        children: reducers.size
          ? [...reducers.values()]
          : [
              {
                label: 'No supported reducer blocks writing selector dependencies resolved',
              },
            ],
      },
      { label: 'Used by', children: usages },
      {
        label:
          'Static analysis: shown blocks write selector dependencies. Output changes depend on runtime values. Unresolved writes and dynamic selectors may be missing.',
      },
    ],
  };
}

module.exports = { inspectSelector, selectorProject };
