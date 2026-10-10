import { Pipe } from '@angular/core';
import type { PipeTransform } from '@angular/core';

/** The ids shown on one grid row: a zero-copy view into the result list. */
@Pipe({ name: 'rowIds' })
export class RowIdsPipe implements PipeTransform {
  transform(row: number, ids: Int32Array, columns: number): Int32Array {
    return ids.subarray(row * columns, (row + 1) * columns);
  }
}
