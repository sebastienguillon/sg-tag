import type { MenuItemConstructorOptions } from 'electron';
import { BrowserWindow, Menu } from 'electron';
import type { ZoomCommand } from './zoom';
import { zoom } from './zoom';

/**
 * Electron's default menu, with zoom items that step like the zoom shortcuts. The shortcuts are
 * handled by `handleZoom`, on any keyboard layout; the accelerators here are for display.
 */
export function applicationMenu(): Menu {
  const zoomItem = (
    label: string,
    accelerator: string,
    command: ZoomCommand,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: (_item, window) => {
      if (window instanceof BrowserWindow) {
        zoom(window, command);
      }
    },
  });
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        zoomItem('Actual Size', 'CommandOrControl+0', 'reset'),
        zoomItem('Zoom In', 'CommandOrControl+Plus', 'in'),
        zoomItem('Zoom Out', 'CommandOrControl+-', 'out'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}
