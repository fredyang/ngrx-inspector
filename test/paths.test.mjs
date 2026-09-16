import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createClassifier } = require('../src/handlers');

it('follows real add-book outputs to the rollback reducer and stops cycles', async () => {
  const base = './fixtures/example-app/books/store/';
  const documents = Object.fromEntries(
    ['books.effects.ts', 'books.state.ts'].map((file) => {
      const text = readFileSync(new URL(base + file, import.meta.url), 'utf8');

      return [
        file,
        {
          uri: { fsPath: file, path: file, toString: () => file },
          getText: () => text,
          positionAt: (offset) => ({ line: 0, character: offset }),
          offsetAt: (position) => position.character,
        },
      ];
    }),
  );

  class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  }

  class Location {
    constructor(uri, range) {
      this.uri = uri;
      this.range = range;
    }
  }

  const vscode = {
    Range,
    Location,
    workspace: {
      openTextDocument: async (uri) => documents[uri.fsPath],
      asRelativePath: (uri) => uri.fsPath,
      getConfiguration: () => ({ get: () => false }),
    },
    commands: {
      executeCommand: async (command, uri, position) => {
        if (command !== 'vscode.executeReferenceProvider') {
          return [];
        }

        const word = documents[uri.fsPath].getText().slice(position.character).match(/^\w+/)[0];

        return Object.values(documents).flatMap((doc) =>
          [...doc.getText().matchAll(new RegExp('\\.' + word + '\\b', 'g'))].map(
            (match) =>
              new Location(
                doc.uri,
                new Range(
                  doc.positionAt(match.index + 1),
                  doc.positionAt(match.index + 1 + word.length),
                ),
              ),
          ),
        );
      },
    },
  };

  const module = { exports: {} };

  vm.runInNewContext(readFileSync(new URL('../src/extension.js', import.meta.url), 'utf8'), {
    module,
    require: (name) =>
      name === 'vscode'
        ? vscode
        : name === './inspector'
          ? {
              eventKey: (_m, d, p) => d.getText().slice(p.character).match(/^\w+/)[0],
            }
          : require('../src/' + name),
  });
  const document = documents['books.effects.ts'];
  const start =
    document.getText().indexOf('SelectedBookPageEvents.addBook') + 'SelectedBookPageEvents.'.length;

  const handler = createClassifier(document.uri.fsPath, document.getText())(start);

  handler.location = new Location(
    document.uri,
    new Range(document.positionAt(start), document.positionAt(handler.end)),
  );
  const token = { isCancellationRequested: false };
  const [tree] = await module.exports.expandEventPaths([handler], token);

  expect(tree.children.map((child) => child.label)).toEqual([
    'CollectionApiEvents.addBookSuccess',
    'CollectionApiEvents.addBookFailure',
  ]);
  expect(tree.children[0].children[0].label).toBe('No supported subscribers found');
  expect(tree.children[1].children).toMatchObject([{ kind: 'Reducer', name: 'collectionReducer' }]);
  const [cycle] = await module.exports.expandEventPaths(
    [handler],
    token,
    new Set([`${document.uri}:${handler.effectStart}`]),
  );

  expect(cycle.children[0].label).toContain('Cycle');
  expect(
    await module.exports.expandEventPaths([handler], {
      isCancellationRequested: true,
    }),
  ).toEqual([]);
});
