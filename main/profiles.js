// Profiles: fully separate setups (tabs, logins, cookies, settings, extensions). Each one is
// its own folder and runs as its own Surf process, so nothing is shared between them.
// The default profile is the original "Browser" folder (never moved or renamed); the others
// live in "Surf Profiles/<id>/" next to it. SURF_PROFILES_ROOT moves that root (for tests).

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const META = 'surf-profile.json';

module.exports = function setupProfiles(M) {
  const root = () => process.env.SURF_PROFILES_ROOT || path.join(app.getPath('appData'), 'Surf Profiles');
  const same = (a, b) => path.resolve(a) === path.resolve(b);

  function readMeta(dir) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8'));
      return meta && typeof meta.name === 'string' ? meta : null;
    } catch {
      return null;
    }
  }

  // Chromium keeps a SingletonLock symlink ("host-pid") in a profile folder while it's open
  function isRunning(dir) {
    try {
      const pid = Number(fs.readlinkSync(path.join(dir, 'SingletonLock')).split('-').pop());
      if (!pid) return false;
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM'; // exists, but not ours to signal
    }
  }

  function list() {
    const profiles = [{ id: 'default', name: 'Default', dir: M.defaultProfileDir, created: 0 }];
    let ids = [];
    try {
      ids = fs.readdirSync(root());
    } catch { /* no profiles yet */ }
    for (const id of ids) {
      const dir = path.join(root(), id);
      const meta = readMeta(dir);
      if (meta) profiles.push({ id, name: meta.name, dir, created: meta.created || 0 });
    }
    profiles.sort((a, b) => a.created - b.created);
    return profiles.map((p) => {
      const current = same(p.dir, M.profileDir);
      return { id: p.id, name: p.name, current, running: current || isRunning(p.dir), isDefault: p.id === 'default' };
    });
  }

  // The profile this process runs, for the window title and sidebar chip.
  // A folder given with SURF_PROFILE_DIR that isn't a named profile shows no name.
  function current() {
    if (same(M.profileDir, M.defaultProfileDir)) return { id: 'default', name: 'Default', isDefault: true };
    const meta = readMeta(M.profileDir);
    const named = same(path.dirname(path.resolve(M.profileDir)), root());
    return { id: named ? path.basename(M.profileDir) : null, name: meta ? meta.name : null, isDefault: false };
  }

  const find = (id) => list().find((p) => p.id === id) || null;
  const dirOf = (id) => (id === 'default' ? M.defaultProfileDir : path.join(root(), id));
  const cleanName = (name) => String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);

  function create(name) {
    name = cleanName(name);
    if (!name) return { error: 'Give the profile a name.' };
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'profile';
    const id = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(root(), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, META), JSON.stringify({ name, created: Date.now() }));
    M.rebuildMenu();
    return { id };
  }

  function rename(id, name) {
    name = cleanName(name);
    if (!name) return { error: 'Give the profile a name.' };
    if (id === 'default' || !find(id)) return { error: 'This profile can’t be renamed.' };
    const dir = dirOf(id);
    fs.writeFileSync(path.join(dir, META), JSON.stringify({ ...readMeta(dir), name }));
    M.rebuildMenu();
    return { ok: true };
  }

  async function remove(id) {
    const p = find(id);
    if (!p || p.isDefault) return { error: 'The default profile can’t be deleted.' };
    if (p.current) return { error: 'You can’t delete the profile you’re using.' };
    if (p.running) return { error: `Quit the “${p.name}” window first.` };
    await fs.promises.rm(dirOf(id), { recursive: true, force: true });
    M.rebuildMenu();
    return { ok: true };
  }

  // Start Surf with that profile folder. If it's already open, its single-instance lock makes
  // the new process hand over to the running one (which comes to the front) and quit.
  function open(id) {
    const p = find(id);
    if (!p) return { error: 'Profile not found.' };
    if (p.current) {
      M.focusMain();
      return { ok: true };
    }
    const env = { ...process.env };
    if (p.isDefault) delete env.SURF_PROFILE_DIR;
    else env.SURF_PROFILE_DIR = dirOf(id);
    const args = app.isPackaged ? [] : [app.getAppPath()];
    const child = spawn(process.execPath, args, { env, detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.error('Could not open profile:', err));
    child.unref();
    return { ok: true };
  }

  ipcMain.handle('profiles-list', () => list());
  ipcMain.handle('profiles-current', () => current());
  ipcMain.handle('profiles-create', (_e, name) => create(name));
  ipcMain.handle('profiles-rename', (_e, id, name) => rename(id, name));
  ipcMain.handle('profiles-delete', (_e, id) => remove(id));
  ipcMain.handle('profiles-open', (_e, id) => open(id));

  return { list, current, open };
};
