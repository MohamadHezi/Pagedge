import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { ask } from '@tauri-apps/plugin-dialog';

// Checks the configured update endpoint once per app session. Safe to call
// even when the endpoint is unreachable/not-yet-live: a non-2xx status or a
// 2xx response whose body isn't a valid signed manifest (e.g. the landing
// page's catch-all HTML) makes check() reject, which we swallow below. The
// explicit timeout guards against the endpoint accepting the connection but
// never responding, since check() has no timeout by default.
export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check({ timeout: 10_000 });
    if (!update) return;

    const shouldInstall = await ask(
      `A new version of Pagedge is available (${update.version}). Would you like to update?`,
      { title: 'Update available', okLabel: 'Install', cancelLabel: 'Later' }
    );
    if (!shouldInstall) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.error('Update check failed:', err);
  }
}
