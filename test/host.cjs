const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function () {
  const extension = vscode.extensions.getExtension('local-ngrx-tools.ngrx-navigator');

  assert.ok(extension, 'Extension is discoverable');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);

  assert.ok(commands.includes('ngrxNavigator.details'));
  assert.deepEqual(
    extension.packageJSON.contributes.menus['editor/context'].map((item) => item.command),
    ['ngrxNavigator.details', 'ngrxNavigator.inspectSelector'],
  );
  assert.ok(!commands.includes('ngrxHandlers.find'));
  assert.ok(!commands.includes('ngrxHandlers.peek'));
  assert.equal(extension.packageJSON.displayName, 'NgRx Navigator');
  assert.equal(extension.packageJSON.version, require('../package.json').version);
  assert.ok(commands.includes('ngrxNavigator.publishers'));
  const {
    findEventReferences,
    findEventMetadata,
    EventDetailsProvider,
  } = require('../dist/extension');

  const uri = vscode.Uri.file(path.join(__dirname, 'workspace', 'component.ts'));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  const position = document.positionAt(document.getText().indexOf('login'));

  editor.selection = new vscode.Selection(position, position);
  const source = new vscode.CancellationTokenSource();
  let handlers = [];

  // The built-in TS server starts asynchronously in a fresh extension host.
  for (let attempt = 0; attempt < 30; attempt++) {
    handlers = await findEventReferences(document, position, source.token);

    if (handlers.length === 2) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  assert.deepEqual(
    handlers.map(({ kind, name }) => ({ kind, name })),
    [
      { kind: 'Effect', name: 'loginEffect' },
      { kind: 'Reducer', name: 'loginReducer' },
    ],
  );
  await vscode.commands.executeCommand('ngrxNavigator.details');

  const publishers = await findEventReferences(document, position, source.token, 'publishers');

  assert.deepEqual(
    publishers.map(({ kind, name }) => ({ kind, name })),
    [
      { kind: 'Dispatch', name: 'Store.dispatch' },
      { kind: 'Effect', name: 'publishLogin' },
    ],
  );
  const provider = new EventDetailsProvider();

  provider.update(publishers, handlers);
  const groups = provider.getChildren();

  assert.deepEqual(
    groups.map((group) => [group.label, provider.getTreeItem(group).description]),
    [
      ['Publishers', '2'],
      ['Subscribers', '2'],
    ],
  );
  const publisher = provider.getChildren(groups[0])[0];
  const item = provider.getTreeItem(publisher);

  await vscode.commands.executeCommand(item.command.command, ...item.command.arguments);
  assert.equal(
    vscode.window.activeTextEditor.document.uri.toString(),
    publisher.location.uri.toString(),
  );
  assert.ok(vscode.window.activeTextEditor.selection.isEqual(publisher.location.range));
  provider.update([], handlers);
  assert.equal(
    provider.getChildren(provider.getChildren()[0])[0].label,
    'No supported locations found',
  );
  provider.dispose();

  const metadata = await findEventMetadata(document, position, source.token);

  assert.equal(metadata.actionType, '[Page] Login');
  assert.equal(metadata.definitions.length, 1);
  assert.ok(metadata.definitions[0].uri.path.endsWith('/events.ts'));
  const details = new EventDetailsProvider();

  details.update(publishers, handlers, metadata);
  const rows = details.getChildren();

  assert.equal(details.getTreeItem(rows[0]).label, 'Definition');
  const definitionItem = details.getTreeItem(rows[0]);

  await vscode.commands.executeCommand(
    definitionItem.command.command,
    ...definitionItem.command.arguments,
  );
  assert.equal(
    vscode.window.activeTextEditor.document.uri.toString(),
    metadata.definitions[0].uri.toString(),
  );
  assert.ok(vscode.window.activeTextEditor.selection.isEqual(metadata.definitions[0].range));
  details.dispose();

  const loginUri = vscode.Uri.file(
    path.resolve(
      __dirname,
      '../../ngrx/projects/example-app/src/app/auth/components/login-page.component.ts',
    ),
  );

  const loginDocument = await vscode.workspace.openTextDocument(loginUri);

  await vscode.window.showTextDocument(loginDocument);
  const loginOffset = loginDocument.getText().indexOf('LoginPageEvents.login');

  assert.ok(loginOffset >= 0);
  const loginPosition = loginDocument.positionAt(loginOffset + 'LoginPageEvents.'.length);
  let loginMetadata;

  for (let attempt = 0; attempt < 20; attempt++) {
    loginMetadata = await findEventMetadata(loginDocument, loginPosition, source.token);

    if (loginMetadata.actionType === '[Login Page] Login') {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  assert.equal(loginMetadata.actionType, '[Login Page] Login');
  assert.ok(
    loginMetadata.definitions.some((location) => location.uri.path.endsWith('/auth.events.ts')),
  );

  const config = vscode.workspace.getConfiguration('ngrxHandlers', uri);

  await config.update('includeTests', true, vscode.ConfigurationTarget.Workspace);

  try {
    assert.equal((await findEventReferences(document, position, source.token)).length, 3);
  } finally {
    await config.update('includeTests', undefined, vscode.ConfigurationTarget.Workspace);
  }

  const effectsUri = vscode.Uri.file(path.join(__dirname, 'workspace', 'effects.ts'));
  const effects = await vscode.workspace.openTextDocument(effectsUri);
  const edit = new vscode.WorkspaceEdit();

  edit.insert(
    effectsUri,
    effects.positionAt(effects.getText().length),
    '\nconst unsaved = ofType(Events.login);\n',
  );
  await vscode.workspace.applyEdit(edit);
  assert.equal(
    (await findEventReferences(document, position, source.token)).length,
    3,
    'Unsaved handlers are included',
  );
  await vscode.window.showTextDocument(effects);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  source.cancel();
  assert.deepEqual(await findEventReferences(document, position, source.token), []);
  source.dispose();
  console.log(
    'NgRx Navigator integration passed: combined command, grouped details, source navigation, empty group, subscribers, publishers, test toggle, unsaved edits, cancellation.',
  );
};
