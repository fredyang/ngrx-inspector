import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inspectSelector } = require('../src/selectors');

it('traces the collection selector through entity selectors to the correct reducers', () => {
  const source = readFileSync(
    new URL('../../ngrx/projects/example-app/src/app/books/store/books.state.ts', import.meta.url),
    'utf8',
  );

  const files = new Map([
    ['/books.state.ts', source],
    ['/component.ts', "import * as books from './books.state'; books.selectBookCollection;"],
  ]);

  const result = inspectSelector(
    files,
    '/component.ts',
    files.get('/component.ts').lastIndexOf('selectBookCollection'),
  );

  expect(result.name).toBe('selectBookCollection');
  expect(result.groups[1].children.map((item) => item.label)).toEqual([
    'books.books.entities',
    'books.collection.ids',
  ]);
  expect(result.groups[2].children.map((item) => item.label)).toEqual([
    'booksReducer',
    'collectionReducer',
  ]);
  expect(JSON.stringify(result.groups[0])).toContain('selectBookEntitiesState');
  expect(JSON.stringify(result.groups[0])).not.toContain('createSelector(');
  const reducers = result.groups[2].children;

  expect(reducers.every((item) => item.start === undefined)).toBe(true);
  expect(reducers.map((item) => item.children.length)).toEqual([2, 3]);

  for (const reducer of reducers) {
    for (const handler of reducer.children) {
      const block = source.slice(handler.start, handler.end);

      expect(block).toMatch(/^on\(/);
      expect(block.endsWith(')')).toBe(true);
      expect(block).not.toContain('createReducer(');
    }
  }

  expect(reducers[0].children[0].label).toBe(
    'on(BooksApiEvents.searchSuccess, CollectionApiEvents.loadBooksSuccess)',
  );
  expect(source.slice(reducers[0].children[1].start, reducers[0].children[1].end)).toBe(
    'on(BookEvents.loadBook, (state, { book }) => bookAdapter.addOne(book, state))',
  );
  expect(JSON.stringify(result.groups[2])).not.toContain('FindBookPageEvents.searchBooks');
  expect(JSON.stringify(result.groups[2])).not.toContain('ViewBookPageEvents.selectBook');
  expect(JSON.stringify(result.groups[2])).not.toContain('CollectionPageEvents.enter');
});

it('resolves renamed imports and reports unsupported registrations', () => {
  const files = new Map([
    [
      '/state.ts',
      "const feature = createFeatureSelector('missing'); export const selectValue = createSelector(feature, state => state.value);",
    ],
    ['/use.ts', "import { selectValue as renamed } from './state'; renamed;"],
  ]);

  const result = inspectSelector(files, '/use.ts', files.get('/use.ts').lastIndexOf('renamed'));

  expect(result.groups[1].children).toEqual([{ label: 'missing.value' }]);
  expect(result.groups[2].children[0].label).toContain('No supported');
});

it('stops selector cycles and rejects ordinary variables', () => {
  const source =
    'const a = createSelector(b, x => x); const b = createSelector(a, x => x); const ordinary = 1;';

  const files = new Map([['/state.ts', source]]);

  expect(JSON.stringify(inspectSelector(files, '/state.ts', source.indexOf('a =')))).toContain(
    'Cycle',
  );
  expect(inspectSelector(files, '/state.ts', source.indexOf('ordinary'))).toBeUndefined();
});

it('matches individual fields and merges handlers for multiple dependencies', () => {
  const source = `
    const feature = createFeatureSelector('example');
    const ids = createSelector(feature, state => state.ids);
    const entities = createSelector(feature, state => state.entities);
    const selected = createSelector(ids, entities, (ids, entities) => ids.map(id => entities[id]));
    const reducer = createReducer({},
      on(loading, state => ({ ...state, loading: true })),
      on(noop, state => state),
      on(preserve, state => ({ ...state, ids: state.ids })),
      on(changeIds, state => ({ ...state, ids: [] })),
      on(changeEntities, state => { return { ...state, entities: {} }; }),
      on(reset, state => ({ loading: false }))
    );
    provideState('example', reducer);
  `;

  const result = inspectSelector(
    new Map([['/state.ts', source]]),
    '/state.ts',
    source.indexOf('selected ='),
  );

  expect(result.groups[2].children[0].children.map((item) => item.label)).toEqual([
    'on(changeIds)',
    'on(reset)',
    'on(changeEntities)',
  ]);
});

it.each([
  ['selectEntities', ['entities']],
  ['selectIds', ['ids']],
  ['selectAll', ['ids', 'entities']],
  ['selectTotal', ['ids']],
])('traces %s accessed from entity selector results', (member, fields) => {
  for (const construction of [
    `const selected = adapter.getSelectors(feature).${member};`,
    `const selectors = adapter.getSelectors(feature); const selected = selectors.${member};`,
    `const { ${member}: selected } = adapter.getSelectors(feature);`,
  ]) {
    const source = `const feature = createFeatureSelector('books'); ${construction} selected;`;
    const result = inspectSelector(
      new Map([['/state.ts', source]]),
      '/state.ts',
      source.lastIndexOf('selected'),
    );

    expect(result.groups[1].children.map((item) => item.label)).toEqual(
      fields.map((field) => `books.${field}`),
    );
  }
});

it.each(['selectUser, selectPermissions', '[selectUser, selectPermissions]'])(
  'preserves sibling dependencies and their shared input for %s',
  (inputs) => {
    const source = `
    const selectAuthState = createFeatureSelector('auth');
    const selectStatus = createSelector(selectAuthState, state => state.status);
    const selectUser = createSelector(selectStatus, status => status.user);
    const selectPermissions = createSelector(selectAuthState, state => state.permissions);
    const selectUserSummary = createSelector(${inputs}, (user, permissions) => ({ user, permissions }));
  `;

    const result = inspectSelector(
      new Map([['/auth.ts', source]]),
      '/auth.ts',
      source.indexOf('selectUserSummary ='),
    );

    expect(result.groups[0].label).toBe('Selector tree');
    expect(result.groups[0].showCount).toBe(false);
    const root = result.groups[0].children[0];

    expect(root).toMatchObject({
      label: 'selectUserSummary',
      kind: 'Selector',
      inspected: true,
    });
    expect(root.children.map((child) => child.label)).toEqual(['selectUser', 'selectPermissions']);
    const [user, permissions] = root.children;

    expect(user.children[0].label).toBe('selectStatus');
    const shared = user.children[0].children[0];

    expect(shared).toMatchObject({
      label: 'selectAuthState',
      kind: 'Selector',
    });
    expect(permissions.children[0]).toEqual(shared);
    const visit = (item) => {
      expect(item.kind).toBe('Selector');
      expect(item.inspected).toBeUndefined();
      item.children?.forEach(visit);
    };

    root.children.forEach(visit);
  },
);
