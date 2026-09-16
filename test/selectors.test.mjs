import { expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inspectSelector } = require('../src/selectors');

it('traces the collection selector through entity selectors to the correct reducers', () => {
  const source = readFileSync(
    new URL('./fixtures/example-app/books/store/books.state.ts', import.meta.url),
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

it('reuses the compiler and invalidates it for edits, additions, and deletions', () => {
  const ts = require('typescript');
  const createProgram = vi.fn((...args) => ts.createProgram(...args));
  const module = { exports: {} };

  vm.runInNewContext(readFileSync(new URL('../src/selectors.js', import.meta.url), 'utf8'), {
    module,
    require: () => ({ ...ts, createProgram }),
  });
  const inspect = module.exports.inspectSelector;
  const files = new Map([
    ['/state.ts', "export const selected = createFeatureSelector('before');"],
    ['/use.ts', "import { selected } from './state'; selected;"],
  ]);

  const run = () =>
    inspect(new Map(files), '/use.ts', files.get('/use.ts').lastIndexOf('selected'));

  expect(run().groups[1].children).toEqual([{ label: 'before' }]);
  expect(run().groups[1].children).toEqual([{ label: 'before' }]);
  expect(createProgram).toHaveBeenCalledTimes(1);

  files.set('/state.ts', "export const selected = createFeatureSelector('after');");
  expect(run().groups[1].children).toEqual([{ label: 'after' }]);
  expect(createProgram).toHaveBeenCalledTimes(2);

  files.set('/extra.ts', 'export const unrelated = 1;');
  run();
  expect(createProgram).toHaveBeenCalledTimes(3);

  files.delete('/state.ts');
  expect(run()).toBeUndefined();
  expect(createProgram).toHaveBeenCalledTimes(4);
});

it('uses inherited project aliases for namespace selectors, imported projectors and computed reducer keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ngrx-selector-'));

  try {
    const project = join(directory, 'app');

    mkdirSync(project);
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@app/*': ['./app/*'] },
        },
      }),
    );
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ extends: '../tsconfig.json' }));
    const component = join(project, 'component.ts');
    const files = new Map([
      [component, "import * as auth from '@app/state'; auth.selectLoginPagePending;"],
      [
        join(project, 'state.ts'),
        `
        import * as login from '@app/login';
        const feature = createFeatureSelector('auth');
        const page = createSelector(feature, state => state.loginPage);
        export const selectLoginPagePending = createSelector(page, login.getPending);
        provideState('auth', combineReducers({ [login.key]: login.reducer }));
      `,
      ],
      [
        join(project, 'login.ts'),
        `
        export const key = 'loginPage';
        export const getPending = state => state.pending;
        export const reducer = createReducer({},
          on(login, state => ({ ...state, pending: true })),
          on(failure, state => ({ ...state, pending: false })),
          on(errorOnly, state => ({ ...state, error: 'error' }))
        );
      `,
      ],
    ]);

    const { selectorProject } = require('../src/selectors');
    const config = selectorProject(component);

    expect(config.directory).toBe(project);
    const result = inspectSelector(
      files,
      component,
      files.get(component).indexOf('selectLoginPagePending'),
      config.options,
    );

    expect(result.groups[1].children).toEqual([{ label: 'auth.loginPage.pending' }]);
    expect(result.groups[2].children[0].children.map((item) => item.label)).toEqual([
      'on(login)',
      'on(failure)',
    ]);
    expect(
      inspectSelector(files, component, files.get(component).indexOf('selectLoginPagePending')),
    ).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  'export const selectBookById = (id: string) => createSelector(selectEntities, entities => entities[id]);',
  'export const selectBookById = (id: string) => { return createSelector(selectEntities, entities => entities[id]); };',
  'export function selectBookById(id: string) { return createSelector(selectEntities, entities => entities[id]); }',
  'export const selectBookById = function(id: string) { const selector = createSelector(selectEntities, entities => entities[id]); return selector; };',
])(
  'traces selector factories at declarations, imported calls, and composed inputs: %s',
  (factory) => {
    const source = `
    const feature = createFeatureSelector('books');
    const selectEntities = createSelector(feature, state => state.entities);
    ${factory}
    export const selectedBook = selectBookById('42');
    export const selectTitle = createSelector(selectBookById('42'), book => book.title);
    const reducer = createReducer({}, on(loaded, (state, { entities }) => ({ ...state, entities })));
    provideState('books', reducer);
  `;

    const usage = "import { selectBookById as byId } from './state'; byId('42');";
    const files = new Map([
      ['/state.ts', source],
      ['/use.ts', usage],
    ]);

    for (const [file, offset] of [
      ['/state.ts', source.indexOf('selectBookById')],
      ['/state.ts', source.indexOf('selectedBook')],
      ['/state.ts', source.indexOf('selectTitle')],
      ['/use.ts', usage.lastIndexOf('byId')],
    ]) {
      const result = inspectSelector(files, file, offset);

      expect(result.groups[1].children).toEqual([{ label: 'books.entities' }]);
      expect(result.groups[2].children[0].children[0].label).toBe('on(loaded)');
      expect(JSON.stringify(result.groups[0])).toContain('selectEntities');
      expect(result.groups[0].children[0].inspected).toBe(true);
    }
  },
);

it('rejects ordinary factories and terminates recursive factories', () => {
  const source = `
    const ordinary = (id: string) => id;
    const recursive = (id: string) => recursive(id);
  `;

  const files = new Map([['/state.ts', source]]);

  expect(inspectSelector(files, '/state.ts', source.indexOf('ordinary'))).toBeUndefined();
  expect(inspectSelector(files, '/state.ts', source.indexOf('recursive'))).toBeUndefined();
});

it('lists navigable selector usages across imports, factories, and composed selectors', () => {
  const state = `
    export const selectQuery = createSelector(createFeatureSelector('search'), state => state.query);
    export const selectById = (id: string) => createSelector(selectQuery, query => query[id]);
  `;

  const use = `
    import * as search from './state';
    import { selectQuery as query, selectById } from './state';
    export { selectQuery } from './state';
    type QuerySelector = typeof query;
    this.searchQuery$ = store.select(search.selectQuery).pipe(take(1));
    const signal = store.selectSignal(query);
    const stream = store.pipe(select(query));
    const composed = createSelector(query, value => value);
    const book = store.select(selectById('42'));
    function unrelated(query: unknown) { return store.select(query); }
  `;

  const files = new Map([
    ['/state.ts', state],
    ['/use.ts', use],
  ]);

  const offset = use.indexOf('selectQuery).pipe');
  const result = inspectSelector(files, '/use.ts', offset);
  const usages = result.groups.find((group) => group.label === 'Used by').children;

  expect(usages).toHaveLength(5);
  expect(usages.filter((item) => item.inspected)).toHaveLength(1);
  expect(usages.find((item) => item.inspected).label).toBe(
    'this.searchQuery$ = store.select(search.selectQuery).pipe(take(1));',
  );
  expect(
    usages.every((item) =>
      ['selectQuery', 'query'].includes(files.get(item.fileName).slice(item.start, item.end)),
    ),
  ).toBe(true);
  expect(usages.some((item) => item.label.includes('store.selectSignal(query)'))).toBe(true);
  expect(usages.some((item) => item.label.includes('store.pipe(select(query))'))).toBe(true);
  const factory = inspectSelector(files, '/state.ts', state.indexOf('selectById'));

  expect(factory.groups.find((group) => group.label === 'Used by').children).toEqual([
    expect.objectContaining({
      fileName: '/use.ts',
      label: "const book = store.select(selectById('42'));",
    }),
  ]);
});

it('shows an empty usages group for an unused selector', () => {
  const source = "export const unused = createFeatureSelector('unused');";
  const result = inspectSelector(
    new Map([['/state.ts', source]]),
    '/state.ts',
    source.indexOf('unused'),
  );

  expect(result.groups.find((group) => group.label === 'Used by').children).toEqual([]);
});
