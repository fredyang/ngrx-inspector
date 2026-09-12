# NgRx Navigator

NgRx Navigator shows the publishers and subscribers of an NgRx action or event in a single VS Code panel with expandable **Publishers** and **Subscribers** groups.

| Editor command           | Windows / Linux        | macOS                        |
| ------------------------ | ---------------------- | ---------------------------- |
| **Inspect Action/Event** | `Ctrl+Alt+N`, then `D` | `Control+Option+N`, then `D` |

The shortcuts are chords: the first combination is released before the final letter. They apply only while a TypeScript or TSX editor has focus. Bindings are customizable in **Keyboard Shortcuts**; other extensions or operating system bindings may conflict.

## Installing or updating

The extension ID is `local-ngrx-tools.ngrx-navigator`. Existing installations of `local-ngrx-tools.ngrx-event-handlers` should be uninstalled or disabled to avoid duplicate commands and panels. **Extensions > … > Install from VSIX…** accepts the generated `ngrx-navigator-<version>.vsix` package. For version 0.7.14, installation from this project directory uses:

```sh
code --install-extension ./ngrx-navigator-0.7.14.vsix
```

VS Code may offer **Reload Window** after installation. Existing custom shortcuts targeting `ngrxNavigator.publishers` or `ngrxNavigator.subscribers` open the combined panel.

This is a local extension, not an official NgRx release or Marketplace publication.

## Navigating subscribers and publishers

With the cursor on the event member, such as `login` in `LoginPageEvents.login`, the editor context menu, Command Palette, and shortcut open the **NgRx Navigator** bottom panel. Each group shows its result count, including an explicit empty state. Results show the handler kind, name, file, and line; selecting a result opens and highlights its source. The context menu command is **Inspect Action/Event**. Each distinct event opens a separate, closable tab. Inspecting an already-open event selects and refreshes its existing tab. Tabs preserve expanded sections and scroll position while switching between events; closing the active tab selects a neighboring tab. Tabs last for the current extension session. Results are a snapshot and do not automatically refresh after edits.

Subscribers include `ofType(LoginPageEvents.login)` in effects and `on(LoginPageEvents.login, ...)` in reducers. Publishers include `store.dispatch(LoginPageEvents.login(...))` and recognized outputs of dispatching effects.

The panel begins with the event's **Type** and **Definition**. For `LoginPageEvents.login`, the type is `[Login Page] Login`; selecting **Definition** opens its declaration in `auth.events.ts`. Definition locations come from TypeScript navigation, and literal action types come from its hover signature. An unresolved or widened type displays **Unavailable** instead of an inferred label.

Tests are excluded by default. The **Include Tests** setting retains its existing key, `ngrxHandlers.includeTests`, so upgrade settings remain intact.

## Supported analysis

Navigation begins with the TypeScript reference provider, then inspects syntax and local bindings. Events with the same name are not combined merely because their spelling matches. Unsaved documents are analyzed directly.

Subscriber patterns:

- `ofType` imported from `@ngrx/effects`, including multiple events and functional or class effects.
- `on` imported from `@ngrx/store`, including multiple events per reducer registration.
- Renamed and namespace imports of these APIs, with locally shadowed names excluded.

Publisher patterns:

- `dispatch` on a receiver identified as an NgRx `Store` through a type annotation or Angular `inject(Store)`, including constructor injection and local aliases.
- Direct action calls, conditional branches, local constant action values, and callbacks passed to `Store.dispatch`.
- Events passed through an RxJS pipeline into `tap(action => store.dispatch(action))`, including local constant aliases of the callback parameter. Only operators preceding the dispatch are traced.
- Outputs returned from `createEffect`, with dispatch enabled or omitted. Literal configurations and local constant configurations are recognized.
- Common RxJS output paths: `map`, `mapTo`, `switchMap`, `mergeMap`, `concatMap`, `exhaustMap`, `catchError`, `of`, `from` with arrays, `defer`, `merge`, `concat`, `race`, `startWith`, and `endWith`.
- Value-preserving operators such as `tap`, `filter`, `take`, `delay`, and `shareReplay`.

An action call inside `tap`, an unused action value, or a value replaced by a later `map` is excluded. Effects configured with `dispatch: false` do not publish their returned values; explicit `Store.dispatch` calls inside them still count.

## Limits

The workspace must be trusted and the built-in TypeScript language features extension enabled. Relevant files must be visible to its project service. If TypeScript is still loading, navigation can be retried once ordinary reference search works.

Results identify static source locations, not runtime registration, subscription, or reachability. Publisher analysis is conservative: custom operators, helper functions, mutable action variables, cross-file value flow, dynamic effect configurations, result selectors, and unknown transformations can yield missing results. Event creator aliases, re-exported NgRx APIs, string action types, legacy reducer switches, subscriber action arrays/spreads, and Signal Store event APIs are not supported. The event member itself must be selected rather than its containing group.

All analysis runs locally. The extension does not execute application code or send source code to a service.

## Developing and testing

From this directory:

```sh
npm install
npm test
npm run build
npm run package
```

The VSIX bundles its TypeScript parser. Unit tests cover subscribers, publishers, false-positive filtering, local shadowing, reference resolution through a barrel, and the example application's login events. Repository fixture tests require the NgRx checkout in the sibling `../ngrx` directory, matching the shared workspace layout.

An isolated integration test exercises the built extension in the installed VS Code:

```sh
code --new-window --verbose \
  --user-data-dir /tmp/ngrx-navigator-vscode-test \
  --extensions-dir /tmp/ngrx-navigator-test-extensions \
  --disable-workspace-trust \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test/host.cjs" \
  "$PWD/test/workspace"
```

Workspace trust is disabled only for this isolated test invocation. The success message starts with `NgRx Navigator integration passed`. The fixture uses local path mappings instead of global NgRx module declarations to avoid affecting the parent repository.

The extension icon is rendered from `assets/icon.svg` to `assets/icon.png`. The monochrome panel icon is `assets/details.svg`; both depict a magnifying glass over the NgRx logo.
