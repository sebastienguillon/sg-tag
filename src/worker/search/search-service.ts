import type { SearchRequest, SearchResult } from '@shared/model';
import type { Statement } from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import type { Db } from '../database/database';
import { compileQuery } from './query-compiler';
import { parseQuery } from './query-parser';

const STATEMENT_CACHE_SIZE = 64;

export class SearchService {
  private readonly db: Db;
  private readonly offlineRootIds: () => readonly number[];
  /** Prepared statements by SQL text; a query's shape repeats a lot while typing. */
  private readonly statements = new Map<string, Statement<(string | number)[], number>>();

  constructor(db: Db, offlineRootIds: () => readonly number[]) {
    this.db = db;
    this.offlineRootIds = offlineRootIds;
  }

  search(request: SearchRequest): SearchResult {
    const started = performance.now();
    const { sql, params } = compileQuery(parseQuery(request.query), request.sort, {
      offlineRootIds: this.offlineRootIds(),
    });
    const ids = this.statement(sql).all(...params);
    return { ids: Int32Array.from(ids), elapsedMs: performance.now() - started };
  }

  private statement(sql: string): Statement<(string | number)[], number> {
    let statement = this.statements.get(sql);
    if (statement) {
      // Refresh recency.
      this.statements.delete(sql);
    } else {
      statement = this.db.prepare<(string | number)[], number>(sql).pluck();
      if (this.statements.size >= STATEMENT_CACHE_SIZE) {
        const oldest = this.statements.keys().next();
        if (oldest.done !== true) {
          this.statements.delete(oldest.value);
        }
      }
    }
    this.statements.set(sql, statement);
    return statement;
  }
}
