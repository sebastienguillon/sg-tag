import { inject, LOCALE_ID, Pipe } from '@angular/core';
import type { PipeTransform } from '@angular/core';

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;
const formatters = new Map<string, Intl.NumberFormat>();

/** Decimal units (1 MB = 1,000,000 bytes), matching the `size:` search syntax. */
export function formatFileSize(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const key = `${locale}/${digits}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: digits });
    formatters.set(key, formatter);
  }
  return `${formatter.format(value)} ${UNITS[unit] ?? 'B'}`;
}

@Pipe({ name: 'fileSize' })
export class FileSizePipe implements PipeTransform {
  private readonly locale = inject(LOCALE_ID);

  transform(bytes: number): string {
    return formatFileSize(bytes, this.locale);
  }
}
