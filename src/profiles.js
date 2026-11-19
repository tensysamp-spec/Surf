// Profiles in the window: which profile this is (window title + a chip in the sidebar's top
// bar), and the Settings section to create, rename, delete and open them. Each profile runs
// as its own Surf process; see main/profiles.js.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

// The default profile shows nothing extra; any other shows its name
async function setup() {
  const me = await ipcRenderer.invoke('profiles-current');
  const name = me && !me.isDefault ? me.name : null;
  document.title = [U.PRIVATE && 'Private', name, 'Surf'].filter(Boolean).join(' — ');
  const chip = U.$('profile-chip');
  chip.hidden = !name;
  chip.textContent = name || '';
  chip.title = name ? `Profile: ${name} — click to manage profiles` : '';
}

async function renderSettings(container) {
  container.replaceChildren();
  const profiles = await ipcRenderer.invoke('profiles-list');
  const list = U.el('div', 'ext-list');
  const refresh = () => {
    renderSettings(container);
    setup();
  };
  for (const p of profiles) {
    const row = U.el('div', 'ext-row');
    const text = U.el('div', 'ext-text');
    const status = [p.isDefault && 'Default', p.current ? 'This window' : p.running && 'Open'].filter(Boolean).join(' · ');
    text.append(U.el('span', 'ext-name', p.name), U.el('span', 'ext-version', status || 'Separate tabs, logins and settings'));
    row.append(U.icon('user'), text);
    const openBtn = U.el('button', 'btn small', p.current ? 'Current' : 'Open');
    openBtn.disabled = p.current;
    openBtn.addEventListener('click', async () => {
      const result = await ipcRenderer.invoke('profiles-open', p.id);
      U.toast(result.error || (p.running ? `Switching to “${p.name}”` : `Opening “${p.name}”…`));
    });
    row.appendChild(openBtn);
    if (!p.isDefault) {
      row.appendChild(U.iconButton('edit', 'Rename', async () => {
        const name = await U.dialog({ title: 'Rename profile', value: p.name, confirmLabel: 'Rename' });
        if (!name) return;
        const result = await ipcRenderer.invoke('profiles-rename', p.id, name);
        if (result.error) U.toast(result.error);
        refresh();
      }, 'h-delete'));
    }
    if (!p.isDefault && !p.current) {
      row.appendChild(U.iconButton('trash', 'Delete', async () => {
        const ok = await U.dialog({
          title: `Delete “${p.name}”?`,
          message: 'Its tabs, history, saved passwords, cookies and settings are removed from this Mac. This can’t be undone.',
          confirmLabel: 'Delete',
          danger: true,
          input: false,
        });
        if (!ok) return;
        const result = await ipcRenderer.invoke('profiles-delete', p.id);
        U.toast(result.error || `Deleted “${p.name}”`);
        refresh();
      }, 'h-delete'));
    }
    list.appendChild(row);
  }
  const add = U.el('button', 'btn', 'New profile…');
  add.addEventListener('click', async () => {
    const name = await U.dialog({ title: 'New profile', message: 'A fully separate Surf with its own tabs, logins and settings — e.g. for work.', placeholder: 'Profile name', confirmLabel: 'Create' });
    if (!name) return;
    const result = await ipcRenderer.invoke('profiles-create', name);
    if (result.error) return U.toast(result.error);
    refresh();
    U.toast(`Created “${name}”`, { actionLabel: 'Open', action: () => ipcRenderer.invoke('profiles-open', result.id) });
  });
  container.append(list, add, U.el('p', 'settings-hint', 'Each profile opens in its own Surf window (also from Surf → Open Profile in the menu bar). The default profile can’t be deleted.'));
}

ctx.profiles = { setup, renderSettings };
