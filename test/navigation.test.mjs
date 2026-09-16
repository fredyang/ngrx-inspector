import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);

it.each(['selector', 'action', 'unsupported'])('routes %s inspection', async (kind) => {
  const uri = { fsPath: '/workspace/state.ts', path: '/workspace/state.ts' };
  const position = { line: 0, character: 0 };
  const word = { start: position, end: position };
  const document = {
    uri,
    languageId: 'typescript',
    getWordRangeAtPosition: () => word,
    getText: () => 'selectedSymbol',
    offsetAt: () => 0,
  };

  const view = { update: vi.fn() };
  const provider = { update: vi.fn(), groups: [] };
  const message = vi.fn();
  const vscode = {
    Location: class {
      constructor(uri, range) {
        this.uri = uri;
        this.range = range;
      }
    },
    RelativePattern: class {
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    ProgressLocation: { Notification: 1 },
    window: {
      activeTextEditor: { document, selection: { active: position } },
      withProgress: (_options, callback) => callback({}, { isCancellationRequested: false }),
      showInformationMessage: message,
      showErrorMessage: vi.fn(),
    },
    workspace: {
      findFiles: vi.fn(async () => []),
      openTextDocument: async () => document,
      getConfiguration: () => ({ get: () => false }),
    },
    commands: {
      executeCommand: vi.fn(async (command) =>
        command === 'vscode.executeHoverProvider' && kind === 'action'
          ? [{ contents: ['ActionCreator<"[Page] Login">'] }]
          : [],
      ),
    },
  };

  const module = { exports: {} };

  vm.runInNewContext(readFileSync(new URL('../src/extension.js', import.meta.url), 'utf8'), {
    module,
    require: (name) => {
      if (name === 'vscode') {
        return vscode;
      }

      if (name === './inspector') {
        return { eventKey: () => 'action:key' };
      }

      if (name === './selectors') {
        return {
          selectorProject: () => ({ directory: '/workspace/app', options: {} }),
          inspectSelector: () =>
            kind === 'selector'
              ? { id: 'selected', name: 'selectedSymbol', groups: [] }
              : undefined,
        };
      }

      return require('../src/' + name);
    },
  });
  await module.exports.inspect(provider, view);

  expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  expect(vscode.workspace.findFiles).toHaveBeenCalledTimes(kind === 'action' ? 0 : 1);

  if (kind !== 'action') {
    expect(vscode.workspace.findFiles.mock.calls[0][0]).toMatchObject({
      base: '/workspace/app',
      pattern: '**/*.{ts,tsx}',
    });
  }

  if (kind === 'unsupported') {
    expect(message).toHaveBeenCalledWith(
      'Not supported. Place the cursor on an NgRx selector or action.',
    );
    expect(view.update).not.toHaveBeenCalled();
  } else {
    expect(message).not.toHaveBeenCalled();
    expect(view.update).toHaveBeenCalledWith(
      kind === 'selector' ? 'selector:selected' : 'action:key',
      kind === 'selector' ? 'selectedSymbol' : '[Page] Login',
      [],
      ...(kind === 'action' ? [expect.objectContaining({ uri, range: word })] : []),
    );
    expect(provider.update).toHaveBeenCalledTimes(kind === 'action' ? 1 : 0);
  }
});
