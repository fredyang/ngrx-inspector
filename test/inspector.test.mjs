import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);

function setup(inspectAction) {
  const vscode = {
    workspace: { asRelativePath: (uri) => uri.toString() },
    window: { showTextDocument: vi.fn() },
  };

  const module = { exports: {} };

  vm.runInNewContext(readFileSync(new URL('../src/inspector.js', import.meta.url), 'utf8'), {
    module,
    require: (name) => (name === 'vscode' ? vscode : require(name)),
  });
  const inspector = new module.exports.InspectorView(inspectAction);
  let receive;
  const webview = {
    postMessage: vi.fn(),
    onDidReceiveMessage: (fn) => {
      receive = fn;

      return { dispose() {} };
    },
  };

  inspector.resolveWebviewView({ webview, onDidDispose() {} });

  return {
    ...module.exports,
    inspector,
    webview,
    vscode,
    receive: (message) => receive(message),
  };
}

const location = (file, line = 1) => ({
  uri: { toString: () => file },
  range: { start: { line, character: 0 } },
});

it('identifies the same event from different references, while separating definitions with the same name', () => {
  const { eventKey } = setup();
  const document = { uri: 'source.ts' };
  const key = eventKey({ definitions: [location('events.ts')] }, document, {
    line: 3,
    character: 2,
  });

  expect(
    eventKey({ definitions: [location('events.ts')] }, document, {
      line: 30,
      character: 2,
    }),
  ).toBe(key);
  expect(
    eventKey({ definitions: [location('other.ts')] }, document, {
      line: 3,
      character: 2,
    }),
  ).not.toBe(key);
});
it('keeps prior inspections, reuses existing tabs, and selects a neighbor when closing', async () => {
  const { inspector, receive } = setup();

  inspector.update('login', 'Login', []);
  inspector.update('success', 'Success', []);
  inspector.update('login', 'Login', [{ label: 'refreshed' }]);
  expect(inspector.tabs.size).toBe(2);
  expect(inspector.active).toBe('login');
  await receive({ type: 'close', id: 'login' });
  expect(inspector.active).toBe('success');
  await receive({ type: 'close', id: 'success' });
  expect(inspector.active).toBeUndefined();
});
it('opens only source locations belonging to a live inspection', async () => {
  const { inspector, receive, vscode } = setup();
  const target = location('effect.ts', 19);

  inspector.update('success', 'Success', [{ kind: 'Effect', name: 'login', location: target }]);
  await receive({ type: 'open', id: 'success', index: 0 });
  expect(vscode.window.showTextDocument).toHaveBeenCalledWith(target.uri, {
    selection: target.range,
    preview: true,
    preserveFocus: false,
  });
  await receive({ type: 'open', id: 'success', index: 99 });
  await receive({ type: 'close', id: 'success' });
  await receive({ type: 'open', id: 'success', index: 0 });
  expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1);
});
it('delivers inspections collected before the view is ready and emits valid browser JavaScript', async () => {
  const { inspector, webview, receive } = setup();

  inspector.update('login', '<Login>', [{ label: 'Type: <Login>' }]);
  await receive({ type: 'ready' });
  expect(webview.postMessage.mock.lastCall[0].tabs[0].name).toBe('<Login>');
  const script = webview.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  expect(() => new vm.Script(script)).not.toThrow();
  expect(webview.html).toContain("default-src 'none'");
});
it('preserves nested effect and event navigation locations', async () => {
  const { inspector, receive, vscode } = setup();
  const effect = location('effects.ts', 80);
  const event = location('effects.ts', 86);
  const reducer = location('state.ts', 109);

  inspector.update('add', 'Add Book', [
    {
      label: 'Subscribers',
      children: [
        {
          kind: 'Effect',
          name: 'addBookToCollection',
          location: effect,
          children: [
            {
              kind: 'Event',
              label: 'CollectionApiEvents.addBookFailure',
              location: event,
              children: [
                {
                  kind: 'Reducer',
                  name: 'collectionReducer',
                  location: reducer,
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
  const nested = inspector.tabs.get('add').groups[0].children[0];

  expect(nested.label).toBe('Effect: addBookToCollection');
  expect(nested.children[0].children[0].label).toBe('Reducer: collectionReducer');

  for (const item of [nested, nested.children[0], nested.children[0].children[0]]) {
    await receive({ type: 'open', id: 'add', index: item.index });
  }

  expect(vscode.window.showTextDocument.mock.calls.map((call) => call[0])).toEqual([
    effect.uri,
    event.uri,
    reducer.uri,
  ]);
});

it('inspects only action rows in live tabs and keeps host locations private', async () => {
  const inspectAction = vi.fn();
  const { inspector, receive, webview, vscode } = setup(inspectAction);
  const action = location('effects.ts', 86);

  inspector.update('add', 'Add Book', [
    {
      kind: 'Effect',
      name: 'add',
      location: location('effects.ts'),
      children: [
        {
          kind: 'Event',
          label: 'CollectionApiEvents.addBookFailure',
          location: action,
        },
      ],
    },
  ]);
  const tab = webview.postMessage.mock.lastCall[0].tabs[0];

  expect(tab.groups[0].children[0].inspectable).toBe(true);
  expect(tab.groups[0].inspectable).toBeUndefined();
  expect(tab).not.toHaveProperty('locations');
  expect(tab).not.toHaveProperty('actions');
  await receive({
    type: 'inspect',
    id: 'add',
    index: tab.groups[0].children[0].index,
  });
  expect(inspectAction).toHaveBeenCalledWith(action);
  await receive({ type: 'inspect', id: 'add', index: tab.groups[0].index });
  await receive({ type: 'inspect', id: 'add', index: 99 });
  await receive({ type: 'close', id: 'add' });
  await receive({
    type: 'inspect',
    id: 'add',
    index: tab.groups[0].children[0].index,
  });
  expect(inspectAction).toHaveBeenCalledTimes(1);
  expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
});

it('renders selector icons and marks only the inspected root while dependencies remain navigable', async () => {
  const { inspector, webview, receive, vscode } = setup();
  const { inspectSelector } = require('../src/selectors');
  const source = `
    const selectAuthState = createFeatureSelector('auth');
    const selectUser = createSelector(selectAuthState, state => state.user);
    const selectPermissions = createSelector(selectAuthState, state => state.permissions);
    const selectSummary = createSelector(selectUser, selectPermissions, (user, permissions) => ({ user, permissions }));
  `;

  const result = inspectSelector(
    new Map([['/auth.ts', source]]),
    '/auth.ts',
    source.indexOf('selectSummary ='),
  );

  const convert = (item) => ({
    ...item,
    ...(item.fileName ? { location: location(item.fileName, item.start) } : {}),
    ...(item.children ? { children: item.children.map(convert) } : {}),
  });

  inspector.update('selector:summary', result.name, result.groups.map(convert));
  const elements = [];

  function element(tag) {
    const node = {
      tag,
      children: [],
      dataset: {},
      attributes: {},
      classList: { toggle() {} },
      append(...children) {
        this.children.push(...children);
      },
      prepend(child) {
        this.children.unshift(child);
      },
      replaceChildren() {
        this.children = [];
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      get firstChild() {
        return this.children[0];
      },
    };

    elements.push(node);

    return node;
  }

  const containers = Object.fromEntries(
    ['tabs', 'panels', 'empty'].map((id) => [id, element('div')]),
  );
  let update;
  const postMessage = vi.fn();

  vm.runInNewContext(webview.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1], {
    acquireVsCodeApi: () => ({
      getState: () => undefined,
      setState() {},
      postMessage,
    }),
    window: {
      addEventListener: (_, listener) => {
        update = listener;
      },
    },
    document: {
      createElement: element,
      createElementNS: (_, tag) => element(tag),
      createTextNode: (text) => ({ textContent: text }),
      getElementById: (id) => containers[id],
      querySelectorAll: () => elements.filter((node) => node.className === 'tab'),
    },
  });
  update({ data: webview.postMessage.mock.lastCall[0] });
  expect(elements.filter((node) => node.tag === 'strong').map((node) => node.textContent)).toEqual([
    'selectSummary',
  ]);
  expect(
    elements.filter((node) => node.tag === 'summary').map((node) => node.textContent),
  ).toContain('Selector tree');
  expect(
    elements.filter((node) => node.tag === 'summary').map((node) => node.textContent),
  ).toContain('State dependencies 2');
  const icons = elements.filter((node) => node.attributes.class === 'icon Selector');

  expect(icons).toHaveLength(5);
  const tabIcon = elements.find((node) => node.attributes.class === 'tab-icon');

  expect(
    icons.every((icon) => icon.children[0].attributes.d === tabIcon.children[0].attributes.d),
  ).toBe(true);
  const dependency = elements.find(
    (node) =>
      node.tag === 'button' &&
      node.children.some((child) => child.textContent === 'selectPermissions'),
  );

  dependency.onclick({ preventDefault() {}, stopPropagation() {}, detail: 1 });
  await receive(postMessage.mock.lastCall[0]);
  expect(vscode.window.showTextDocument).toHaveBeenCalledOnce();
  expect(elements.filter((node) => node.tag === 'strong').map((node) => node.textContent)).toEqual([
    'selectSummary',
  ]);
});

it('marks only the action reference at the inspection origin and refreshes the marker', () => {
  const { inspector } = setup();
  const reference = (file, line) => ({
    ...location(file, line),
    range: { start: { line, character: 20 }, end: { line, character: 25 } },
  });

  const groups = [
    {
      label: 'Publishers',
      children: [
        { kind: 'Dispatch', name: 'onSubmit', location: reference('login.ts', 26) },
        { kind: 'Dispatch', name: 'retry', location: reference('login.ts', 30) },
        { kind: 'Dispatch', name: 'onSubmit', location: reference('other.ts', 26) },
      ],
    },
  ];

  const marked = () =>
    inspector.tabs.get('login').groups[0].children.map((item) => !!item.inspected);

  inspector.update('login', 'Login', groups, reference('login.ts', 26));
  expect(marked()).toEqual([true, false, false]);
  inspector.update('login', 'Login', groups, reference('login.ts', 30));
  expect(marked()).toEqual([false, true, false]);
  inspector.update('login', 'Login', groups, reference('login.ts', 40));
  expect(marked()).toEqual([false, false, false]);
});
