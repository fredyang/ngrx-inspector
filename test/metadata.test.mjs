import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const { actionTypeFromHover } = createRequire(import.meta.url)('../src/metadata');

it.each([
  [
    '(property) login: ActionCreator<"[Login Page] Login", (props: Credentials) => Action>',
    '[Login Page] Login',
  ],
  ['```typescript\n(property) login: () => { type: "[Page] Login"; }\n```', '[Page] Login'],
  ["Action<'[Auth] Logout'>", '[Auth] Logout'],
  ['ActionCreator<"[Page] Say \\"hello\\"", () => Action>', '[Page] Say "hello"'],
  ['(property) login: () => { type: string; }', undefined],
  ['ActionCreator<"A" | "B", () => Action>', undefined],
  ['(property) login: () => { type: "A" | "B"; }', undefined],
])('extracts only a known action type from %s', (value, expected) => {
  expect(actionTypeFromHover([{ value }])).toBe(expected);
});

it('resolves the full tab title from a usage when the declaration shows props', async () => {
  const require = createRequire(import.meta.url);
  const definition = {
    uri: 'events.ts',
    range: { start: { line: 10, character: 2 } },
  };

  const usage = {
    uri: 'effects.ts',
    range: { start: { line: 20, character: 4 } },
  };

  const vscode = {
    commands: {
      executeCommand: async (command, uri) => {
        if (command === 'vscode.executeDefinitionProvider') {
          return [definition];
        }

        if (command === 'vscode.executeReferenceProvider') {
          return [definition, usage];
        }

        return [
          {
            contents: [
              {
                value:
                  uri === definition.uri
                    ? '(property) searchSuccess: ActionCreatorProps<{ books: Book[]; }>'
                    : '(property) searchSuccess: ActionCreator<"[Books/API] Search Success", (props: { books: Book[]; }) => Action>',
              },
            ],
          },
        ];
      },
    },
  };

  const module = { exports: {} };

  vm.runInNewContext(readFileSync(new URL('../src/extension.js', import.meta.url), 'utf8'), {
    module,
    require: (name) =>
      name === 'vscode' ? vscode : name === './inspector' ? {} : require('../src/' + name),
  });
  const metadata = await module.exports.findEventMetadata(
    { uri: definition.uri },
    definition.range.start,
    { isCancellationRequested: false },
  );

  expect(metadata.actionType).toBe('[Books/API] Search Success');
  expect(metadata.definitions).toEqual([definition]);
});
