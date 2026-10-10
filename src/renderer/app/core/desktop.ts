import { DOCUMENT, inject, InjectionToken } from '@angular/core';
import type { DesktopBridge } from '@shared/desktop-api';

declare global {
  interface Window {
    /** Exposed by the Electron preload script. */
    readonly sgTag?: DesktopBridge;
  }
}

/** Main-process services (folder picker, open/reveal files, worker port) exposed by the preload. */
export const DESKTOP = new InjectionToken<DesktopBridge>('DesktopBridge', {
  providedIn: 'root',
  factory: () => {
    const bridge = inject(DOCUMENT).defaultView?.sgTag;
    if (!bridge) {
      throw new Error('SG Tag must run inside its Electron shell (window.sgTag is missing).');
    }
    return bridge;
  },
});
