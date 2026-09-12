import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createClassifier } = require('../src/handlers');

const imports = `
  import { Store } from '@ngrx/store';
  import { inject } from '@angular/core';
  import { createEffect, ofType } from '@ngrx/effects';
  import { of, from, defer, concat } from 'rxjs';
  import { map, tap, filter, switchMap, mergeMap, exhaustMap, concatMap, catchError, take, startWith } from 'rxjs/operators';
`;

function classify(code, prefix = imports) {
  const text = prefix + code.replace('|', '');

  return createClassifier('/fixture.ts', text, 'publishers')(prefix.length + code.indexOf('|'));
}

describe('event publishers', () => {
  it('recognizes a namespace Store type annotation', () => {
    expect(
      classify(
        `function login(store: ngrx.Store) { store.dispatch(Events.|login()); }`,
        `import * as ngrx from '@ngrx/store';`,
      )?.kind,
    ).toBe('Dispatch');
  });
  it.each([
    `const store = inject(Store); store.dispatch(Events.|login());`,
    `class Component { store = inject(Store); login() { this.store.dispatch(Events.|login()); } }`,
    `class Component { constructor(private store: Store) {} login() { this.store.dispatch(Events.|login()); } }`,
    `function login(store: Store) { store.dispatch(Events.|login()); }`,
    `const store = inject(Store); store.dispatch(() => Events.|login());`,
    `const store = inject(Store); store.dispatch(() => { return Events.|login(); });`,
    `const store = inject(Store); const action = Events.|login(); store.dispatch(action);`,
    `const store = inject(Store); store.dispatch(ok ? Events.|login() : Events.other());`,
    `const store = inject(Store); const alias = store; alias.dispatch(Events.|login());`,
  ])('recognizes Store.dispatch: %s', (code) => {
    expect(classify(code)?.kind).toBe('Dispatch');
  });

  it.each([
    `source.pipe(map(() => Events.|login()), tap(action => store.dispatch(action)), map(() => true));`,
    `source.pipe(map(() => Events.|login()), filter(Boolean), take(1), tap(action => { const event = action; store.dispatch(event); }));`,
    `of(Events.|login()).pipe(tap(action => store.dispatch(action)));`,
    `source.pipe(switchMap(() => of(Events.|login())), tap(action => store.dispatch(action)));`,
  ])('traces dispatched tap inputs: %s', (code) => {
    expect(classify(`const store = inject(Store); ${code}`)?.kind).toBe('Dispatch');
  });

  it.each([
    `source.pipe(map(() => Events.|login()), map(() => Events.other()), tap(action => store.dispatch(action)));`,
    `source.pipe(map(() => Events.|login()), customOperator(), tap(action => store.dispatch(action)));`,
    `source.pipe(map(() => Events.|login()), tap(action => log(action)));`,
    `source.pipe(map(() => Events.|login()), tap(action => { action = Events.other(); store.dispatch(action); }));`,
    `source.pipe(map(() => Events.|login()), tap(action => { function nested(action) { store.dispatch(action); } }));`,
    `source.pipe(tap(action => store.dispatch(action)), map(() => Events.|login()));`,
  ])('excludes unrelated or replaced tap inputs: %s', (code) => {
    expect(classify(`const store = inject(Store); ${code}`)).toBeUndefined();
  });

  it('finds the book guard publisher', () => {
    const text = readFileSync(
      new URL(
        '../../ngrx/projects/example-app/src/app/books/guards/book-exists.guard.ts',
        import.meta.url,
      ),
      'utf8',
    );

    const offset = text.indexOf('BookEvents.loadBook(') + 'BookEvents.'.length;

    expect(createClassifier('/book-exists.guard.ts', text, 'publishers')(offset)).toMatchObject({
      kind: 'Dispatch',
      name: 'hasBookInApi',
    });
  });

  it('recognizes aliased Angular and NgRx imports', () => {
    expect(
      classify(
        `const store = di(AppStore); store.dispatch(Events.|login());`,
        `import { Store as AppStore } from '@ngrx/store'; import { inject as di } from '@angular/core';`,
      )?.kind,
    ).toBe('Dispatch');
  });

  it.each([
    `const effect = createEffect(() => actions.pipe(map(() => Events.|login())));`,
    `const effect = createEffect(() => actions.pipe(map(() => { const unused = other(); return Events.|login(); })));`,
    `const effect = createEffect(() => actions.pipe(exhaustMap(() => api().pipe(map(() => Events.|login())))));`,
    `const effect = createEffect(() => actions.pipe(switchMap(() => of(Events.|login()))));`,
    `const effect = createEffect(() => actions.pipe(mergeMap(() => [Events.|login(), Events.other()])));`,
    `const effect = createEffect(() => actions.pipe(concatMap(() => from([Events.|login()]))));`,
    `const effect = createEffect(() => actions.pipe(catchError(() => of(Events.|login()))));`,
    `const effect = createEffect(() => of(Events.|login()).pipe(filter(Boolean), tap(log), take(1)));`,
    `const effect = createEffect(() => of(Events.|login()).pipe(map(action => action)));`,
    `const effect = createEffect(() => of(Events.|login()), { functional: true, dispatch: true });`,
    `const effect = createEffect(() => defer(() => of(Events.|login())));`,
    `const effect = createEffect(() => concat(of(Events.other()), of(Events.|login())));`,
    `const effect = createEffect(() => actions.pipe(map(() => ok ? Events.|login() : Events.other())));`,
    `const effect = createEffect(() => { const action = Events.|login(); return of(action); });`,
    `const effect = createEffect(() => actions.pipe(startWith(Events.|login())));`,
  ])('recognizes effect output: %s', (code) => {
    expect(classify(code)?.kind).toBe('Effect');
  });

  it.each([
    `Events.|login();`,
    `const store = { dispatch() {} }; store.dispatch(Events.|login());`,
    `const store = inject(Store); function f(store) { store.dispatch(Events.|login()); }`,
    `const store = inject(Store); store.dispatch(wrapper(Events.|login()));`,
    `const effect = createEffect(() => actions.pipe(ofType(Events.|login)));`,
    `const effect = createEffect(() => actions.pipe(tap(() => Events.|login())));`,
    `const effect = createEffect(() => of(Events.|login()), { dispatch: false });`,
    `const config = { dispatch: false }; const effect = createEffect(() => of(Events.|login()), config);`,
    `const effect = createEffect(() => of(Events.|login()), { ...config });`,
    `const effect = createEffect(() => actions.pipe(map(() => { Events.|login(); return Events.other(); })));`,
    `const effect = createEffect(() => of(Events.|login()).pipe(map(() => Events.other())));`,
    `const effect = createEffect(() => of(Events.|login()).pipe(customOperator()));`,
    `const effect = createEffect(() => { const unused = of(Events.|login()); return of(Events.other()); });`,
    `const effect = createEffect(() => actions.pipe(map(() => ({ nested: Events.|login() }))));`,
    `const effect = createEffect(() => actions.pipe(map(() => { function nested() { return Events.|login(); } return Events.other(); })));`,
    `const effect = createEffect(() => actions.pipe(switchMap(() => of(Events.|login()), () => Events.other())));`,
    `function f(createEffect) { const effect = createEffect(() => of(Events.|login())); }`,
    `const effect = createEffect(() => actions.pipe(map(() => { let action = Events.|login(); action = other(); return action; })));`,
  ])('excludes non-publishing references: %s', (code) => {
    expect(classify(code)).toBeUndefined();
  });

  it('includes explicit dispatch even inside a non-dispatching effect', () => {
    expect(
      classify(
        `const store = inject(Store); const effect = createEffect(() => actions.pipe(tap(() => store.dispatch(Events.|login()))), {dispatch: false});`,
      )?.kind,
    ).toBe('Dispatch');
  });

  it('recognizes aliased RxJS and createEffect imports', () => {
    expect(
      classify(
        `const effect = effectFactory(() => actions.pipe(project(() => Events.|login())));`,
        `import {createEffect as effectFactory} from '@ngrx/effects'; import {map as project} from 'rxjs';`,
      )?.kind,
    ).toBe('Effect');
  });

  it('finds the repository login success and failure emissions', () => {
    const text = readFileSync(
      new URL(
        '../../ngrx/projects/example-app/src/app/auth/store/auth.effects.ts',
        import.meta.url,
      ),
      'utf8',
    );

    const classify = createClassifier('/auth.effects.ts', text, 'publishers');

    for (const name of ['loginSuccess', 'loginFailure']) {
      const offset = text.indexOf(`AuthApiEvents.${name}(`) + 'AuthApiEvents.'.length;

      expect(classify(offset)).toMatchObject({ kind: 'Effect', name: 'login' });
    }
  });
});
