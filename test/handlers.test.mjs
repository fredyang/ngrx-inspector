import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createClassifier, isTestFile } = require('../src/handlers');
const ts = require('typescript');

function marked(code) {
  const offset = code.indexOf('|');
  const text = code.replace('|', '');

  return createClassifier('/fixture.ts', text)(offset);
}

describe('handler classification', () => {
  it('finds a functional effect', () => {
    expect(
      marked(`import {ofType} from '@ngrx/effects';
      const login = createEffect(() => actions.pipe(ofType(Events.|login))));`),
    ).toMatchObject({ kind: 'Effect', name: 'login' });
  });
  it('finds class effects and multiple action registrations', () => {
    expect(
      marked(`import {ofType} from '@ngrx/effects';
      class Effects { login$ = createEffect(() => actions.pipe(ofType(other, Events.|login))); }`),
    ).toMatchObject({ kind: 'Effect', name: 'login$' });
  });
  it('finds reducer handlers with aliased imports', () => {
    expect(
      marked(`import {on as handle} from '@ngrx/store';
      const reducer = createReducer({}, handle(other, Events.|login, state => state));`),
    ).toMatchObject({ kind: 'Reducer', name: 'reducer' });
  });
  it('finds namespace imports and wrapped arguments', () => {
    expect(
      marked(`import * as effects from '@ngrx/effects';
      const login = effects.ofType((Events.|login as ActionCreator));`),
    ).toMatchObject({ kind: 'Effect', name: 'login' });
  });
  it.each([
    `import {ofType} from '@ngrx/effects'; store.dispatch(Events.|login());`,
    `import {ofType} from '@ngrx/effects'; const e = ofType(other).pipe(map(() => Events.|login()));`,
    `import {on} from '@ngrx/store'; on(other, state => Events.|login());`,
    `import {ofType} from 'unrelated'; ofType(Events.|login);`,
    `import {ofType} from '@ngrx/effects'; function f(ofType) { ofType(Events.|login); }`,
    `import * as effects from '@ngrx/effects'; function f(effects) { effects.ofType(Events.|login); }`,
    `import {ofType} from '@ngrx/effects'; ofType(Events.|login());`,
    `import {ofType} from '@ngrx/effects'; ofType([Events.|login]);`,
    `import {ofType} from '@ngrx/effects'; ofType(|Events.login);`,
    `import {ofType} from '@ngrx/effects'; const events = { |login: createAction('login') };`,
  ])('excludes non-handler usage: %s', (code) => {
    expect(marked(code)).toBeUndefined();
  });
  it.each([
    '/src/login.spec.ts',
    '/src/login.test.tsx',
    'C:\\app\\__tests__\\login.ts',
    '/tests/login.ts',
  ])('recognizes test files: %s', (path) => expect(isTestFile(path)).toBe(true));
  it.each(['/src/auth.effects.ts', '/src/latest/login.ts', '/src/test-utils.ts'])(
    'keeps application files: %s',
    (path) => expect(isTestFile(path)).toBe(false),
  );
});

describe('TypeScript reference integration', () => {
  it('follows an event through a barrel and import alias without mixing another login event', () => {
    const files = {
      '/events.ts': `export const Events = { login: () => ({ type: 'login' }) };`,
      '/barrel.ts': `export { Events } from './events';`,
      '/component.ts': `import { Events } from './events'; Events.login();`,
      '/effects.ts': `import { Events as Page } from './barrel'; import { ofType } from '@ngrx/effects';
        const effect = ofType(Page.login); const Other = { login: 1 }; ofType(Other.login);`,
      '/state.ts': `import { Events } from './events'; import { on } from '@ngrx/store';
        const reducer = on(Events.login, state => state);`,
    };

    const host = {
      getCompilationSettings: () => ({
        moduleResolution: ts.ModuleResolutionKind.Node10,
      }),
      getScriptFileNames: () => Object.keys(files),
      getScriptVersion: () => '1',
      getScriptSnapshot: (file) =>
        files[file] === undefined ? undefined : ts.ScriptSnapshot.fromString(files[file]),
      getCurrentDirectory: () => '/',
      getDefaultLibFileName: () => '/lib.d.ts',
      fileExists: (file) => file in files,
      readFile: (file) => files[file],
    };

    const service = ts.createLanguageService(host);
    const references = service.getReferencesAtPosition(
      '/component.ts',
      files['/component.ts'].indexOf('login'),
    );

    const handlers = references.flatMap((reference) => {
      const handler = createClassifier(
        reference.fileName,
        files[reference.fileName],
      )(reference.textSpan.start);

      return handler ? [{ kind: handler.kind, name: handler.name }] : [];
    });

    expect(handlers).toEqual([
      { kind: 'Effect', name: 'effect' },
      { kind: 'Reducer', name: 'reducer' },
    ]);
    service.dispose();
  });
  it('recognizes the repository login effect and reducer', () => {
    for (const [file, kind, name] of [
      ['auth.effects.ts', 'Effect', 'login'],
      ['auth.state.ts', 'Reducer', 'loginPageReducer'],
    ]) {
      const url = new URL(
        `../../ngrx/projects/example-app/src/app/auth/store/${file}`,
        import.meta.url,
      );

      const text = readFileSync(url, 'utf8');

      expect(
        createClassifier(
          file,
          text,
        )(text.indexOf('LoginPageEvents.login') + 'LoginPageEvents.'.length),
      ).toMatchObject({ kind, name });
    }
  });
});
