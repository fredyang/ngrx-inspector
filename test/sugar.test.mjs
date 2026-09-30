import { expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClassifier } = require('../src/handlers');
const { inspectSelector } = require('../src/selectors');

it('recognizes fluent handlers and task subscriptions with alias and namespace imports', () => {
  const source = `
    import { state as defineState, tasks as defineTasks } from '@ngrx-sugar/store';
    import * as sugar from '@ngrx-sugar/store';
    const base = defineState('books', { loading: false });
    const books = base.on(Events.entered, s => ({...s, loading: true}))
      .on(Events.loaded, Events.failed, s => ({...s, loading: false}));
    const more = sugar.state('more', {}).on(Events.entered, s => s);
    const jobs = defineTasks((when) => ({
      load: when(Events.entered, Events.retry, pipe => pipe()),
      log: when(Events.loaded, pipe => pipe(), { dispatch: false }),
    }));
    const noise = other.on(Events.entered, s => s);
    function shadow(defineState) { defineState('fake', {}).on(Events.entered, s => s); }
    const fake = otherTasks(on => ({ load: on(Events.entered, pipe => pipe()) }));
  `;

  const registrations = createClassifier('/state.ts', source).registrations;

  expect(registrations.map((x) => [x.kind, x.name, source.slice(x.start, x.end)])).toEqual([
    ['Reducer', 'books', 'loaded'],
    ['Reducer', 'books', 'failed'],
    ['Reducer', 'books', 'entered'],
    ['Reducer', 'more', 'entered'],
    ['Effect', 'load', 'entered'],
    ['Effect', 'load', 'retry'],
    ['Effect', 'log', 'loaded'],
  ]);
  expect(
    new Set(registrations.filter((x) => x.name === 'books').map((x) => x.registrationStart)).size,
  ).toBe(2);
});

it('follows task outputs, sources, renamed pipes, and dispatch:false without counting discarded values', () => {
  const source = `
    import { tasks } from '@ngrx-sugar/store';
    import { map, tap, switchMap, catchError, of } from 'rxjs';
    const jobs = tasks((when) => ({
      load: when(Events.entered, (flow) => flow(
        switchMap(() => api.load().pipe(
          tap(() => Events.discarded()),
          map(data => Events.loaded({data})),
          catchError(() => of(Events.failed()))
        ))
      )),
      source: when(() => of(Events.started())),
      silent: when(Events.loaded, pipe => pipe(map(() => Events.silent())), { dispatch: false }),
      replaced: when(Events.loaded, pipe => pipe(map(() => Events.replaced()), map(() => 0))),
      custom: when(Events.loaded, pipe => pipe(map(() => Events.unknown()), customOperator())),
    }));
    Events.entered.publish();
    Events.loaded({data: []});
  `;

  const publishers = createClassifier('/tasks.ts', source, 'publishers').registrations;

  expect(publishers.map((x) => [x.kind, x.eventName])).toEqual([
    ['Effect', 'Events.loaded'],
    ['Effect', 'Events.failed'],
    ['Effect', 'Events.started'],
    ['Dispatch', 'Events.entered'],
  ]);
  const subscriber = createClassifier('/tasks.ts', source).registrations.find(
    (x) => x.name === 'load',
  );

  expect(
    publishers
      .filter((x) => x.name === 'load')
      .every((x) => x.effectStart === subscriber.effectStart),
  ).toBe(true);
  expect(publishers.at(-1).sugarPublish).toBe(true);
});

const state = `
  import { state as defineState, view as derive } from '@ngrx-sugar/store';
  const initial = { ids: [], selectedId: null, loading: false, nested: { title: '' } };
  export const books = defineState('books', initial)
    .on(Events.entered, s => ({ ...s, loading: true }))
    .on(Events.loaded, (s, { ids }) => ({ ...s, ids, loading: false }))
    .on(Events.selected, (s, { id }) => ({ ...s, selectedId: id }))
    .on(Events.title, (s, { title }) => ({ ...s, nested: { ...s.nested, title } }))
    .withViews(({ ids: allIds, selectedId, nested }) => ({
      selected: derive(allIds, selectedId, (ids, id) => ids.includes(id)),
      title: derive(nested, n => n.title),
    }))
    .withViews(v => ({ upper: derive(v.title, t => t.toUpperCase()) }));
  export const booksViews = books.views;
`;

function inspectUsage(usage, name) {
  const files = new Map([
    ['/state.ts', state],
    ['/use.ts', `import { books, booksViews as views } from './state'; ${usage}`],
  ]);

  const source = files.get('/use.ts');

  return inspectSelector(files, '/use.ts', source.lastIndexOf(name));
}

it.each([
  ['books.views.ids.signal()', 'ids', ['books.ids'], ['on(Events.loaded)']],
  [
    'views.selected.observable()',
    'selected',
    ['books.ids', 'books.selectedId'],
    ['on(Events.loaded)', 'on(Events.selected)'],
  ],
  ['views.upper.signal()', 'upper', ['books.nested.title'], ['on(Events.title)']],
  [
    'views.root.signal()',
    'root',
    ['books'],
    ['on(Events.entered)', 'on(Events.loaded)', 'on(Events.selected)', 'on(Events.title)'],
  ],
  [
    'const { title: caption } = views; caption.signal()',
    'caption',
    ['books.nested.title'],
    ['on(Events.title)'],
  ],
])('traces %s to state and only relevant fluent reducer blocks', (usage, name, paths, handlers) => {
  const result = inspectUsage(usage, name);

  expect(result.groups[1].children.map((x) => x.label)).toEqual(paths);
  const blocks = result.groups[2].children.flatMap((x) => x.children);

  expect(blocks.map((x) => x.label)).toEqual(handlers);

  for (const block of blocks) {
    expect(state.slice(block.start, block.end)).toMatch(/^on\(/);
    expect(state.slice(block.start, block.end)).not.toContain('.withViews');
  }

  expect(result.groups[3].children.filter((x) => x.fileName === '/use.ts')).toHaveLength(
    name === 'caption' ? 2 : 1,
  );
});

it('traces Eventify views as selectors', () => {
  const source = `
    import { state, view } from '@ngrx-eventify/store';
    const books = state('books', { ids: [] })
      .on(Events.loaded, (current, { ids }) => ({ ...current, ids }))
      .withViews(({ ids }) => ({ collection: view(ids, value => value) }));
    books.views.collection.signal();
  `;

  const result = inspectSelector(
    new Map([['/eventify.ts', source]]),
    '/eventify.ts',
    source.lastIndexOf('collection.signal') + 1,
  );

  expect(result.groups[1].children).toEqual([{ label: 'books.ids' }]);
  expect(
    result.groups[2].children.flatMap((group) => group.children).map((item) => item.label),
  ).toEqual(['on(Events.loaded)']);
});

it('recognizes Eventify event publishers, state handlers, and tasks', () => {
  const source = `
    import { map } from 'rxjs';
    import { state, tasks } from '@ngrx-eventify/store';
    const books = state('books', { loaded: false })
      .on(Events.loaded, current => ({ ...current, loaded: true }));
    const jobs = tasks(on => ({
      load: on(Events.entered, pipe => pipe(map(() => Events.loaded()))),
    }));
    Events.entered.publish();
  `;

  const subscribers = createClassifier('/eventify.ts', source).registrations;
  const publishers = createClassifier('/eventify.ts', source, 'publishers').registrations;

  expect(subscribers.map((entry) => [entry.kind, source.slice(entry.start, entry.end)])).toEqual([
    ['Reducer', 'loaded'],
    ['Effect', 'entered'],
  ]);
  expect(publishers.map((entry) => [entry.kind, entry.eventName])).toEqual([
    ['Effect', 'Events.loaded'],
    ['Dispatch', 'Events.entered'],
  ]);
});

it('composes standalone views with ordinary NgRx selectors and views from other features', () => {
  const source = `
    import * as sugar from '@ngrx-sugar/store';
    import { booksViews } from './state';
    const auth = sugar.state('auth', { user: null });
    const standard = createFeatureSelector('settings');
    const combined = sugar.view(booksViews.selected, auth.views.user, standard, (a, b, c) => [a,b,c]);
    combined;
  `;

  const result = inspectSelector(
    new Map([
      ['/state.ts', state],
      ['/use.ts', source],
    ]),
    '/use.ts',
    source.lastIndexOf('combined'),
  );

  expect(result.groups[1].children.map((x) => x.label)).toEqual([
    'books.ids',
    'books.selectedId',
    'auth.user',
    'settings',
  ]);
});

it('keeps generated view identities separate for two features sharing initial state', () => {
  const source = `import { state } from '@ngrx-sugar/store'; const initial = { count: 0 };
    const a = state('a', initial); const b = state('b', initial); a.views.count; b.views.count;`;

  const files = new Map([['/state.ts', source]]);
  const a = inspectSelector(files, '/state.ts', source.indexOf('a.views.count') + 8);
  const b = inspectSelector(files, '/state.ts', source.indexOf('b.views.count') + 8);

  expect(a.id).not.toBe(b.id);
  expect(a.groups[1].children).toEqual([{ label: 'a.count' }]);
  expect(b.groups[1].children).toEqual([{ label: 'b.count' }]);
});

it('does not interpret unrelated state and view APIs as Sugar', () => {
  const source = `import { state, view } from 'other-library';
    const feature = state('fake', {count: 0});
    const derived = view(feature.views.count, x => x); feature.views.count; derived;`;

  const files = new Map([['/state.ts', source]]);

  expect(inspectSelector(files, '/state.ts', source.lastIndexOf('derived'))).toBeUndefined();
  expect(inspectSelector(files, '/state.ts', source.lastIndexOf('count'))).toBeUndefined();
});
