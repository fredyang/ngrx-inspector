# Developing NgRx Inspector

[Extension overview](README.md)

The following commands run from the NgRx Inspector project root.

## Developing and testing

```sh
npm ci
npm test
npm run format:check
npm run package
```

Packaging runs the build automatically. The build bundles the TypeScript parser without changing the package version. `npm run build` is also available for development without packaging.

Vitest tests cover action publishers and subscribers, selector trees, shared dependencies, reducer matching, and inspector rendering. Example sources and their license are stored in `test/fixtures/example-app`; no sibling NgRx checkout is required. These fixtures are parsed as source text, so their Angular and NgRx imports do not need to be installed for the unit suite.

The separate VS Code extension-host test can be launched after building:

```sh
code --new-window --verbose \
  --user-data-dir /tmp/ngrx-navigator-vscode-test \
  --extensions-dir /tmp/ngrx-navigator-test-extensions \
  --disable-workspace-trust \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test/host.cjs" \
  "$PWD/test/workspace"
```

Workspace trust is disabled only for this isolated test invocation. The success message starts with `NgRx Inspector integration passed`.
