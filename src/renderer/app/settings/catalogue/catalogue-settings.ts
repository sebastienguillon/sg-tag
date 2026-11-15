import { DecimalPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { CatalogueStore } from '../../core/catalogue-store';

/**
 * The classification catalogue in Settings: which one SG Tag reads, what it found in it, and the
 * buttons to choose another or stop using it.
 */
@Component({
  selector: 'app-catalogue-settings',
  imports: [DecimalPipe],
  templateUrl: './catalogue-settings.html',
  styleUrl: './catalogue-settings.css',
})
export class CatalogueSettings {
  protected readonly store = inject(CatalogueStore);

  protected choose(): void {
    void this.store.choose();
  }

  protected forget(): void {
    void this.store.forget();
  }
}
