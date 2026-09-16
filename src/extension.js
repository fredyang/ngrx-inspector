const vscode = require('vscode');
const { InspectorView, eventKey } = require('./inspector');
const { createClassifier, isTestFile } = require('./handlers');
const { actionTypeFromHover } = require('./metadata');

async function findEventMetadata(document, position, token) {
  if (token.isCancellationRequested) {
    return { definitions: [] };
  }

  const [definitions, hovers] = await Promise.all([
    vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position),
    vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, position),
  ]);

  if (token.isCancellationRequested) {
    return { definitions: [] };
  }

  const seen = new Set();
  const locations = (definitions || []).flatMap((definition) => {
    const location = definition.targetUri
      ? new vscode.Location(
          definition.targetUri,
          definition.targetSelectionRange || definition.targetRange,
        )
      : definition;

    const key = `${location.uri}:${location.range.start.line}:${location.range.start.character}`;

    if (seen.has(key)) {
      return [];
    }

    seen.add(key);

    return [location];
  });
  let actionType = actionTypeFromHover((hovers || []).flatMap((hover) => hover.contents));

  // Group declarations expose the props configuration, while usages expose
  // the generated action creator and its full literal type.
  if (!actionType) {
    const references =
      (await vscode.commands.executeCommand(
        'vscode.executeReferenceProvider',
        document.uri,
        position,
      )) || [];

    for (const reference of references) {
      if (token.isCancellationRequested) {
        return { definitions: [] };
      }

      if (
        reference.uri.toString() === document.uri.toString() &&
        reference.range.start.line === position.line &&
        reference.range.start.character === position.character
      ) {
        continue;
      }

      const referenceHovers = await vscode.commands.executeCommand(
        'vscode.executeHoverProvider',
        reference.uri,
        reference.range.start,
      );

      actionType = actionTypeFromHover((referenceHovers || []).flatMap((hover) => hover.contents));

      if (actionType) {
        break;
      }
    }
  }

  if (token.isCancellationRequested) {
    return { definitions: [] };
  }

  return {
    actionType,
    definitions: locations,
  };
}

async function findEventReferences(document, position, token, direction = 'subscribers') {
  if (token.isCancellationRequested) {
    return [];
  }

  const references =
    (await vscode.commands.executeCommand(
      'vscode.executeReferenceProvider',
      document.uri,
      position,
    )) || [];

  const includeTests = vscode.workspace
    .getConfiguration('ngrxHandlers', document.uri)
    .get('includeTests', false);

  const files = new Map();

  for (const reference of references) {
    if (!includeTests && isTestFile(vscode.workspace.asRelativePath(reference.uri, false))) {
      continue;
    }

    if (reference.uri.path.includes('/node_modules/')) {
      continue;
    }

    const key = reference.uri.toString();

    if (!files.has(key)) {
      files.set(key, []);
    }

    files.get(key).push(reference);
  }

  const results = [];
  const seen = new Set();

  for (const referencesInFile of files.values()) {
    if (token.isCancellationRequested) {
      return [];
    }

    const target = await vscode.workspace.openTextDocument(referencesInFile[0].uri);
    const classify = createClassifier(target.uri.fsPath, target.getText(), direction);

    for (const reference of referencesInFile) {
      const handler = classify(target.offsetAt(reference.range.start));

      if (!handler) {
        continue;
      }

      const key = `${target.uri}:${handler.registrationStart}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      results.push({
        ...handler,
        location: new vscode.Location(
          target.uri,
          new vscode.Range(target.positionAt(handler.start), target.positionAt(handler.end)),
        ),
      });
    }
  }

  return results.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.location.uri.toString().localeCompare(b.location.uri.toString()) ||
      a.start - b.start,
  );
}

// Follow effect outputs through the same symbol reference provider as the root.
// Bound expansion and track effects per branch because event flows can cycle.
async function expandEventPaths(handlers, token, ancestors = new Set(), depth = 0) {
  const results = [];

  for (const handler of handlers) {
    if (token.isCancellationRequested) {
      return [];
    }

    if (handler.kind !== 'Effect' || handler.effectStart === undefined) {
      results.push(handler);
      continue;
    }

    const key = `${handler.location.uri}:${handler.effectStart}`;

    if (ancestors.has(key) || depth >= 8) {
      results.push({
        ...handler,
        children: [
          {
            label: ancestors.has(key)
              ? 'Cycle: effect already shown in this path'
              : 'Depth limit reached',
          },
        ],
      });
      continue;
    }

    const branch = new Set(ancestors).add(key);
    const document = await vscode.workspace.openTextDocument(handler.location.uri);
    const outputs = createClassifier(
      document.uri.fsPath,
      document.getText(),
      'publishers',
    ).registrations.filter(
      (entry) => entry.kind === 'Effect' && entry.effectStart === handler.effectStart,
    );

    const children = [];
    const seen = new Set();

    for (const output of outputs) {
      if (token.isCancellationRequested) {
        return [];
      }

      const position = document.positionAt(output.start);
      const [metadata, subscribers] = await Promise.all([
        findEventMetadata(document, position, token),
        findEventReferences(document, position, token),
      ]);

      const identity = eventKey(metadata, document, position);

      if (seen.has(identity)) {
        continue;
      }

      seen.add(identity);
      children.push({
        kind: 'Event',
        label: output.eventName,
        location: new vscode.Location(
          document.uri,
          new vscode.Range(position, document.positionAt(output.end)),
        ),
        children: subscribers.length
          ? await expandEventPaths(subscribers, token, branch, depth + 1)
          : [{ label: 'No supported subscribers found' }],
      });
    }

    results.push({
      ...handler,
      children: children.length ? children : [{ label: 'No supported output actions found' }],
    });
  }

  return results;
}

class EventDetailsProvider {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.groups = [];
  }

  update(publishers, subscribers, metadata) {
    const definitions = [];

    if (metadata) {
      for (const location of metadata.definitions) {
        definitions.push({ kind: 'Definition', name: 'Definition', location });
      }

      if (definitions.length === 0) {
        definitions.push({ label: 'Definition: Unavailable' });
      }
    }

    this.groups = [
      ...definitions,
      {
        label: 'Publishers',
        children: publishers.map((publisher) => ({
          ...publisher,
          isPublisher: true,
        })),
      },
      { label: 'Subscribers', children: subscribers },
    ];
    this.changed.fire();
  }

  getChildren(element) {
    if (!element) {
      return this.groups;
    }

    if (!element.children) {
      return [];
    }

    return element.children.length ? element.children : [{ label: 'No supported locations found' }];
  }

  getTreeItem(element) {
    if (element.children) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);

      item.id = element.label;
      item.description = String(element.children.length);

      return item;
    }

    if (!element.location) {
      return new vscode.TreeItem(element.label);
    }

    const { uri, range } = element.location;
    const item = new vscode.TreeItem(
      element.kind === 'Definition' ? 'Definition' : `${element.kind}: ${element.name}`,
    );

    item.description = `${vscode.workspace.asRelativePath(uri)}:${range.start.line + 1}`;
    item.tooltip = `${item.label}\n${item.description}`;
    const icons = {
      Dispatch: ['broadcast', 'charts.blue'],
      Effect: ['globe', 'charts.green'],
      Reducer: ['database', 'charts.purple'],
      Definition: ['symbol-method', 'charts.foreground'],
    };

    const [icon, color] = element.isPublisher
      ? ['broadcast', 'charts.blue']
      : icons[element.kind] || ['symbol-event', 'charts.foreground'];

    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.command = {
      command: 'vscode.open',
      title: 'Open Source',
      arguments: [uri, { selection: range, preview: true }],
    };

    return item;
  }

  dispose() {
    this.changed.dispose();
  }
}

let requestId = 0;

async function navigate(provider, view, location) {
  const editor = vscode.window.activeTextEditor;

  if (
    (!location && !editor) ||
    (!location && !['typescript', 'typescriptreact'].includes(editor.document.languageId))
  ) {
    return;
  }

  const document = location
    ? await vscode.workspace.openTextDocument(location.uri)
    : editor.document;

  const position = location ? location.range.start : editor.selection.active;
  const word = document.getWordRangeAtPosition(position);

  if (!word) {
    await vscode.window.showInformationMessage(
      'Not supported. Place the cursor on an NgRx selector or action.',
    );

    return;
  }

  const eventName = document.getText(word);
  const currentRequest = ++requestId;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Finding event details for ${eventName}…`,
        cancellable: true,
      },
      async (_progress, token) => {
        const [publishers, subscribers, metadata] = await Promise.all([
          findEventReferences(document, word.start, token, 'publishers'),
          findEventReferences(document, word.start, token, 'subscribers'),
          findEventMetadata(document, word.start, token),
        ]);

        if (token.isCancellationRequested || currentRequest !== requestId) {
          return;
        }

        if (!metadata.actionType && publishers.length === 0 && subscribers.length === 0) {
          await vscode.window.showInformationMessage(
            'Not supported. Place the cursor on an NgRx selector or action.',
          );

          return;
        }

        const [publisherPaths, subscriberPaths] = await Promise.all([
          expandEventPaths(publishers, token),
          expandEventPaths(subscribers, token),
        ]);

        if (token.isCancellationRequested || currentRequest !== requestId) {
          return;
        }

        provider.update(publisherPaths, subscriberPaths, metadata);
        view.update(
          eventKey(metadata, document, word.start),
          metadata.actionType || eventName,
          provider.groups,
          new vscode.Location(document.uri, word),
        );
        await vscode.commands.executeCommand('ngrxNavigator.eventDetails.focus');
      },
    );
  } catch (error) {
    await vscode.window.showErrorMessage(
      `NgRx event navigation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function inspect(provider, view, location) {
  const editor = vscode.window.activeTextEditor;

  if (
    !location &&
    (!editor || !['typescript', 'typescriptreact'].includes(editor.document.languageId))
  ) {
    return;
  }

  const document = location
    ? await vscode.workspace.openTextDocument(location.uri)
    : editor.document;

  const word = document.getWordRangeAtPosition(
    location ? location.range.start : editor.selection.active,
  );

  if (!word) {
    await vscode.window.showInformationMessage(
      'Not supported. Place the cursor on an NgRx selector or action.',
    );

    return;
  }

  const currentRequest = ++requestId;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Inspecting NgRx symbol ${document.getText(word)}…`,
        cancellable: true,
      },
      async (_progress, token) => {
        // Known actions do not need the workspace-wide selector compiler.
        const hovers = await vscode.commands.executeCommand(
          'vscode.executeHoverProvider',
          document.uri,
          word.start,
        );

        if (token.isCancellationRequested || currentRequest !== requestId) {
          return;
        }

        if (actionTypeFromHover((hovers || []).flatMap((hover) => hover.contents))) {
          await navigate(provider, view, new vscode.Location(document.uri, word));

          return;
        }

        const { inspectSelector, selectorProject } = require('./selectors');
        const project = selectorProject(document.uri.fsPath);
        const uris = await vscode.workspace.findFiles(
          project.directory
            ? new vscode.RelativePattern(project.directory, '**/*.{ts,tsx}')
            : '**/*.{ts,tsx}',
          '**/{node_modules,dist,.git,coverage}/**',
        );

        const files = new Map();
        const documents = new Map();

        // Bound concurrency to avoid flooding the extension host on large workspaces.
        const pending = uris.filter((uri) => !isTestFile(uri.fsPath));
        let next = 0;
        const readDocuments = async () => {
          while (next < pending.length) {
            if (token.isCancellationRequested || currentRequest !== requestId) {
              return;
            }

            const uri = pending[next++];
            const target = await vscode.workspace.openTextDocument(uri);

            documents.set(uri.fsPath, target);
          }
        };

        await Promise.all(Array.from({ length: Math.min(8, pending.length) }, readDocuments));

        if (token.isCancellationRequested || currentRequest !== requestId) {
          return;
        }

        for (const uri of pending) {
          files.set(uri.fsPath, documents.get(uri.fsPath).getText());
        }

        files.set(document.uri.fsPath, document.getText());
        documents.set(document.uri.fsPath, document);
        const result = inspectSelector(
          files,
          document.uri.fsPath,
          document.offsetAt(word.start),
          project.options,
        );

        if (token.isCancellationRequested || currentRequest !== requestId) {
          return;
        }

        if (!result) {
          await navigate(provider, view, new vscode.Location(document.uri, word));

          return;
        }

        const convert = (item) => {
          const target = documents.get(item.fileName);
          const converted = { ...item };

          if (target) {
            converted.location = new vscode.Location(
              target.uri,
              new vscode.Range(target.positionAt(item.start), target.positionAt(item.end)),
            );
          }

          if (item.children) {
            converted.children = item.children.map(convert);
          }

          return converted;
        };

        view.update(
          `selector:${result.id}`,
          result.name,
          result.groups.map(convert),
        );
        await vscode.commands.executeCommand('ngrxNavigator.eventDetails.focus');
      },
    );
  } catch (error) {
    await vscode.window.showErrorMessage(
      `NgRx inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function activate(context) {
  const provider = new EventDetailsProvider();
  const view = new InspectorView((location) => inspect(provider, view, location));

  context.subscriptions.push(
    provider,
    view,
    vscode.window.registerWebviewViewProvider('ngrxNavigator.eventDetails', view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('ngrxNavigator.details', () => inspect(provider, view)),
    vscode.commands.registerCommand('ngrxNavigator.inspectSelector', () => inspect(provider, view)),
    // Preserve existing custom shortcuts without adding duplicate menu entries.
    vscode.commands.registerCommand('ngrxNavigator.subscribers', () => inspect(provider, view)),
    vscode.commands.registerCommand('ngrxNavigator.publishers', () => inspect(provider, view)),
  );
}

module.exports = {
  activate,
  inspect,
  findEventReferences,
  findEventMetadata,
  expandEventPaths,
  EventDetailsProvider,
};
