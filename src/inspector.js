const vscode = require('vscode');
const crypto = require('node:crypto');

function eventKey(metadata, document, position) {
  const locations = metadata.definitions
    .map(({ uri, range }) => `${uri.toString()}:${range.start.line}:${range.start.character}`)
    .sort();

  return locations.length
    ? locations.join('|')
    : `${document.uri.toString()}:${position.line}:${position.character}`;
}

class InspectorView {
  constructor(inspectAction) {
    this.inspectAction = inspectAction;
    this.tabs = new Map();
    this.active = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    this.listener = view.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'ready') {
        this.send();
      }

      if (message.type === 'select' && this.tabs.has(message.id)) {
        this.active = message.id;
      }

      if (message.type === 'close') {
        const ids = [...this.tabs.keys()];
        const index = ids.indexOf(message.id);

        this.tabs.delete(message.id);

        if (this.active === message.id) {
          this.active = ids[index + 1] || ids[index - 1];
        }

        this.send();
      }

      if (message.type === 'inspect') {
        const tab = this.tabs.get(message.id);
        const location = tab?.actions[message.index];

        if (location) {
          await this.inspectAction?.(location);
        }
      }

      if (message.type === 'open') {
        const tab = this.tabs.get(message.id);
        const location = tab?.locations[message.index];

        if (location) {
          await vscode.window.showTextDocument(location.uri, {
            selection: location.range,
            preview: true,
            preserveFocus: false,
          });
        }
      }
    });
    view.onDidDispose(() => {
      this.listener.dispose();
      this.view = undefined;
    });
  }

  update(id, name, groups) {
    const locations = [];
    const actions = [];
    const serialize = (item) => {
      const result = {
        label:
          item.label || (item.kind === 'Definition' ? 'Definition' : `${item.kind}: ${item.name}`),
      };

      if (item.showCount === false) {
        result.showCount = false;
      }

      if (item.inspected) {
        result.inspected = true;
      }

      if (item.children) {
        result.children = item.children.map(serialize);
      }

      if (item.location) {
        result.index = locations.push(item.location) - 1;

        if (item.kind === 'Event') {
          result.inspectable = true;
          actions[result.index] = item.location;
        }

        result.description = `${vscode.workspace.asRelativePath(item.location.uri)}:${item.location.range.start.line + 1}`;
        result.kind = item.isPublisher || item.kind === 'Event' ? 'Publisher' : item.kind;
      }

      return result;
    };

    this.tabs.set(id, {
      id,
      name,
      groups: groups.map(serialize),
      locations,
      actions,
    });
    this.active = id;
    this.send();
  }

  send() {
    this.view?.webview.postMessage({
      type: 'update',
      active: this.active,
      tabs: [...this.tabs.values()].map(({ locations, actions, ...tab }) => tab),
    });
  }

  dispose() {
    this.listener?.dispose();
  }
}

function html() {
  const nonce = crypto.randomBytes(16).toString('hex');

  return `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { padding:0; margin:0; color:var(--vscode-foreground); background:var(--vscode-panel-background); font:var(--vscode-font-size) var(--vscode-font-family); }
#tabs { display:flex; overflow-x:auto; border-bottom:1px solid var(--vscode-panel-border); }
.tab { display:flex; flex-shrink:0; border-right:1px solid var(--vscode-panel-border); }
button { font:inherit; color:inherit; background:transparent; border:0; cursor:pointer; }
.tab.selected { background:var(--vscode-tab-activeBackground); border-top:2px solid var(--vscode-focusBorder); }
.tab button { padding:8px; }
.tab button[role="tab"] { display:flex; align-items:center; gap:6px; }
.tab-icon { width:16px; height:16px; flex-shrink:0; fill:none; stroke:currentColor; stroke-width:1.2; stroke-linecap:round; stroke-linejoin:round; }
button:focus-visible, summary:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
.panel { height:calc(100vh - 38px); overflow:auto; box-sizing:border-box; padding:12px 16px; }
.panel[hidden] { display:none; }
.row { display:block; padding:4px 0; text-align:left; white-space:pre-wrap; overflow-wrap:anywhere; }
button.row:hover { background:var(--vscode-list-hoverBackground); }
.inspecting-badge { margin-left:8px; padding:1px 5px; border-radius:3px; font-size:.85em; color:var(--vscode-descriptionForeground); border:1px solid var(--vscode-panel-border); }
.description { opacity:.7; margin-left:8px; }
details { margin:6px 0; }
details > details { margin-left:20px; }
details > .row { margin-left:40px; }
summary { display:flex; align-items:center; cursor:pointer; list-style:none; }
summary::-webkit-details-marker { display:none; }
summary::before { content:'▶'; flex:0 0 16px; margin-right:4px; font-size:10px; text-align:center; }
details[open] > summary::before { content:'▼'; }
summary > .row { display:inline-block; margin-left:0; }
.icon { display:inline-block; width:16px; height:16px; margin-right:6px; vertical-align:-3px; flex-shrink:0; } .Publisher { color:var(--vscode-charts-blue); } .Effect { color:var(--vscode-charts-yellow); } .Reducer { color:var(--vscode-charts-purple); }
#empty { padding:16px; }
</style></head><body><div id="tabs" role="tablist" aria-label="Inspected events and selectors"></div><div id="panels"></div><p id="empty">Place the cursor on an NgRx event or selector and run Inspect Action or Inspect Selector.</p>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
const states = saved.states || {};
const selectorIconPath = 'M6 13H2V2h12v5M2 5h12M5 5v8M2 9h4M7 11s1.5-3 4-3 4 3 4 3-1.5 3-4 3-4-3-4-3ZM12 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0';
const panels = new Map();
let active;
function persist() { vscode.setState({states}); }
function select(id) {
  active = id;
  for (const [key, panel] of panels) {
    panel.hidden = key !== id;
    if (key === id) panel.scrollTop = states[key]?.scroll || 0;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    const selected = tab.dataset.id === id;
    tab.classList.toggle('selected', selected);
    tab.firstChild.setAttribute('aria-selected', String(selected));
    tab.firstChild.tabIndex = selected ? 0 : -1;
  }
}
window.addEventListener('message', ({data}) => {
  if (data.type !== 'update') return;
  const ids = new Set(data.tabs.map(t => t.id));
  for (const [id, panel] of panels) if (!ids.has(id)) { panel.remove(); panels.delete(id); delete states[id]; }
  const tabs = document.getElementById('tabs'); tabs.replaceChildren();
  document.getElementById('empty').hidden = data.tabs.length > 0;
  data.tabs.forEach((tab, i) => {
    const state = states[tab.id] ||= {scroll:0, collapsed:{}};
    const wrapper = document.createElement('div'); wrapper.className = 'tab'; wrapper.dataset.id = tab.id;
    const button = document.createElement('button'); button.textContent = tab.name; button.title = tab.name; button.setAttribute('role','tab');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'tab-icon'); icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', tab.id.startsWith('selector:')
      ? selectorIconPath
      : 'M9.5 1 3 9h4l-.5 6L13 7H9l.5-6Z');
    icon.append(path); button.prepend(icon);
    button.id = 'tab-' + i; button.setAttribute('aria-controls','panel-' + i);
    button.onclick = () => { select(tab.id); vscode.postMessage({type:'select', id:tab.id}); };
    button.onkeydown = (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (i + 1) % data.tabs.length;
      if (event.key === 'ArrowLeft') next = (i + data.tabs.length - 1) % data.tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = data.tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); const target = tabs.children[next].firstChild; target.click(); target.focus(); }
    };
    const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label','Close ' + tab.name);
    close.onclick = () => vscode.postMessage({type:'close', id:tab.id});
    wrapper.append(button, close); tabs.append(wrapper);
    let panel = panels.get(tab.id);
    if (!panel) { panel = document.createElement('div'); panel.className = 'panel'; panels.set(tab.id,panel); document.getElementById('panels').append(panel); }
    panel.id = 'panel-' + i; panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby',button.id);
    panel.onscroll = () => { if (!panel.hidden) { state.scroll = panel.scrollTop; persist(); } };
    const signature = JSON.stringify(tab.groups);
    if (panel.dataset.signature !== signature) {
      panel.replaceChildren(); panel.dataset.signature = signature;
      function row(item, parent, path) {
        if (item.children) {
          const group = document.createElement('details'); group.open = !state.collapsed[path];
          const summary = document.createElement('summary');
          if (item.index !== undefined) row({...item, children:undefined}, summary, path);
          else summary.textContent = item.label + (item.showCount === false ? '' : ' ' + item.children.length);
          group.append(summary);
          group.ontoggle = () => { state.collapsed[path] = !group.open; persist(); };
          if (!item.children.length) row({label:'No supported locations found'},group);
          item.children.forEach((child, index) => row(child,group,path + '/' + index)); parent.append(group); return;
        }
        const element = document.createElement(item.index === undefined ? 'div' : 'button'); element.className = 'row';
        if (item.kind) {
          const paths = {
            Publisher: ['M5 5a4.25 4.25 0 0 0 0 6M11 5a4.25 4.25 0 0 1 0 6', 'M3 3a7.1 7.1 0 0 0 0 10M13 3a7.1 7.1 0 0 1 0 10', 'M8 7.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5'],
            Effect: ['M2 5h11m-3-3 3 3-3 3M14 11H3m3-3-3 3 3 3'],
            Reducer: ['M2.5 4c0-3 11-3 11 0s-11 3-11 0Z', 'M2.5 4v8c0 3 11 3 11 0V4', 'M2.5 8c0 3 11 3 11 0'],
            Selector: [selectorIconPath],
            Definition: ['M8 1.5 14 4.5v7L8 15l-6-3.5v-7Z', 'm2 4.5 6 3 6-3M8 7.5V15'],
          };
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.setAttribute('class', 'icon ' + item.kind);
          icon.setAttribute('viewBox', '0 0 16 16');
          icon.setAttribute('fill', 'none');
          icon.setAttribute('stroke', 'currentColor');
          icon.setAttribute('stroke-width', '1.2');
          icon.setAttribute('stroke-linecap', 'round');
          icon.setAttribute('stroke-linejoin', 'round');
          icon.setAttribute('aria-hidden', 'true');
          for (const d of paths[item.kind] || paths.Definition) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d); icon.append(path);
          }
          element.append(icon);
        }
        if (item.showCount === false) result.showCount = false;
      if (item.inspected) {
          const label = document.createElement('strong'); label.textContent = item.label; element.append(label);
          const badge = document.createElement('span'); badge.className = 'inspecting-badge'; badge.textContent = 'Inspecting'; element.append(badge);
        } else element.append(document.createTextNode(item.label));
        if (item.kind === 'Selector') element.title = 'Open selector source. Nested selectors are dependencies of this selector.';
        if (item.description) { const description = document.createElement('span'); description.className = 'description'; description.textContent = item.description; element.append(description); }
        if (item.index !== undefined) {
          let clickTimer;
          element.onclick = (event) => {
            event.preventDefault(); event.stopPropagation();
            const open = () => vscode.postMessage({type:'open',id:tab.id,index:item.index});
            if (!item.inspectable || event.detail === 0) { open(); return; }
            clearTimeout(clickTimer);
            if (event.detail === 1) clickTimer = setTimeout(open, 300);
          };
          if (item.inspectable) {
            element.title = 'Click to open source; double-click to inspect action';
            element.ondblclick = (event) => {
              event.preventDefault(); event.stopPropagation(); clearTimeout(clickTimer);
              vscode.postMessage({type:'inspect',id:tab.id,index:item.index});
            };
          }
        }
        parent.append(element);
      }
      tab.groups.forEach((item, index) => row(item,panel,String(index)));
    }
  });
  select(data.active); persist();
});
vscode.postMessage({type:'ready'});
</script></body></html>`;
}

module.exports = { InspectorView, eventKey };
