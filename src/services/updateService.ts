import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { ask } from '@tauri-apps/plugin-dialog';

// Checks the configured update endpoint once per app session. Safe to call
// even when the endpoint is unreachable/not-yet-live — check() rejects and
// we swallow the error so startup never blocks on this.
export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
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
