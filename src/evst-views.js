const ts = require('typescript');

// Generated views have no declaration of their own. Keep a stable descriptor
// anchored to the initial-state field, or to the derived view's property.
function sugarViews(sugar, sourceFiles) {
  const states = new Map();
  const baseViews = new Map();
  const byNode = new Map();
  const scopes = new Map();
  const features = [];
  const propertyName = (node) => node.name?.text;
  const walk = (node, visit) => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };

  function returned(fn) {
    fn = sugar.value(fn);

    if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) {
      return;
    }

    if (!ts.isBlock(fn.body)) {
      return sugar.value(fn.body);
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

    return returns.length === 1 ? sugar.value(returns[0]) : undefined;
  }

  function fields(expression, seen = new Set()) {
    const node = sugar.value(expression);

    if (!node || seen.has(node) || !ts.isObjectLiteralExpression(node)) {
      return [];
    }

    const branch = new Set(seen).add(node);

    return node.properties.flatMap((entry) =>
      ts.isSpreadAssignment(entry)
        ? fields(entry.expression, branch)
        : propertyName(entry)
          ? [entry]
          : [],
    );
  }

  function stateViews(expression) {
    const node = sugar.value(expression);

    if (!node) {
      return;
    }

    if (states.has(node)) {
      return states.get(node);
    }

    const chain = sugar.stateChain(node);

    if (!chain) {
      return;
    }

    const key = sugar.value(chain.base.arguments[0]);

    if (!key || !ts.isStringLiteralLike(key)) {
      return;
    }

    // Install a placeholder before following derived inputs to stop cycles.
    states.set(node, undefined);
    let views = baseViews.get(chain.base);

    if (!views) {
      views = new Map();
      const entries = fields(chain.base.arguments[1]);

      for (const field of entries) {
        const name = propertyName(field);

        views.set(name, {
          sugarView: true,
          node: field,
          name,
          paths: [[key.text, name]],
          base: chain.base,
        });
      }

      views.set('root', {
        sugarView: true,
        node: chain.base,
        name: 'root',
        paths: [[key.text]],
        base: chain.base,
      });
      baseViews.set(chain.base, views);
    }

    views = new Map(views);

    for (const step of chain.steps) {
      if (!['extraViews', 'withViews'].includes(step.expression.name.text)) {
        continue;
      }

      const callback = sugar.value(step.arguments[0]);
      const parameter = callback?.parameters?.[0];

      if (parameter) {
        scopes.set(parameter, new Map(views));
      }

      const object = returned(callback);

      if (!object || !ts.isObjectLiteralExpression(object)) {
        continue;
      }

      for (const field of fields(object)) {
        const name = propertyName(field);

        if (views.has(name)) {
          continue;
        }

        let descriptor = byNode.get(field);

        if (!descriptor) {
          descriptor = {
            sugarView: true,
            node: field,
            name,
            initializer: field.initializer || field.name,
            base: chain.base,
          };
          byNode.set(field, descriptor);

          if (field.name) {
            byNode.set(field.name, descriptor);
          }
        }

        views.set(name, descriptor);
      }
    }

    states.set(node, views);

    return views;
  }

  function viewMap(expression, seen = new Set()) {
    if (!expression || seen.has(expression)) {
      return;
    }

    const branch = new Set(seen).add(expression);

    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'views') {
      return stateViews(expression.expression);
    }

    const decl = sugar.declaration(expression);

    if (scopes.has(decl)) {
      return scopes.get(decl);
    }

    if (decl?.initializer) {
      return viewMap(decl.initializer, branch);
    }

    if (decl && ts.isBindingElement(decl) && decl.propertyName?.text === 'views') {
      return stateViews(decl.parent.parent.initializer);
    }
  }

  function resolve(expression, seen = new Set()) {
    if (!expression || seen.has(expression)) {
      return;
    }

    if (byNode.has(expression)) {
      return byNode.get(expression);
    }

    const branch = new Set(seen).add(expression);

    if (
      ts.isIdentifier(expression) &&
      ts.isPropertyAccessExpression(expression.parent) &&
      expression.parent.name === expression
    ) {
      return resolve(expression.parent, branch);
    }

    if (ts.isPropertyAccessExpression(expression)) {
      const views = viewMap(expression.expression);

      if (views) {
        return views.get(expression.name.text);
      }

      // Selecting signal/observable itself should inspect its owning view.
      if (['signal', 'observable'].includes(expression.name.text)) {
        return resolve(expression.expression, branch);
      }
    }

    const decl = sugar.declaration(expression);

    if (byNode.has(decl)) {
      return byNode.get(decl);
    }

    if (decl && ts.isBindingElement(decl)) {
      const owner = decl.parent.parent;
      const views = scopes.get(owner) || viewMap(owner.initializer);

      if (views) {
        return views.get((decl.propertyName || decl.name).text);
      }
    }

    if (decl?.initializer) {
      return resolve(decl.initializer, branch);
    }
  }

  for (const source of sourceFiles) {
    walk(source, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) {
        return;
      }

      const views = stateViews(node.initializer);

      if (!views) {
        return;
      }

      const chain = sugar.stateChain(node.initializer);
      const name = sugar.value(chain.base.arguments[0]).text;

      features.push({ name, reducer: node.initializer, label: node.name.getText(), chain });
    });
  }

  return { resolve, features };
}

module.exports = { sugarViews };
