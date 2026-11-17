export interface TranslatedQuery {
  sql: string;
  params: any[];
  isUpdateReturning: boolean;
  updateMeta?: {
    table: string;
    alias?: string;
    returningCols: string;
    whereClause: string;
    whereParamIndices?: number[];
    whereParams?: any[];
    pkCol?: string;
  };
  isInsertReturning?: boolean;
  insertMeta?: {
    table: string;
    returningCols: string;
    pkCol: string;
    keyWhereClause?: string;
    keyParams?: any[];
    hasOnConflict?: boolean;
    usesNativeReturning?: boolean;
  };
  isDeleteReturning?: boolean;
  deleteMeta?: {
    table: string;
    alias?: string;
    returningCols: string;
    whereClause: string;
    whereParams?: any[];
  };
}

/**
 * Splits a comma-separated SQL list at depth 0, respecting quotes and nested parentheses.
 */
function splitTopLevelSqlList(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      current += ch;
      i++;
      while (i < input.length) {
        current += input[i];
        if (input[i] === quote) {
          if (i + 1 < input.length && input[i + 1] === quote) {
            i++;
            current += input[i];
            i++;
            continue;
          }
          i++;
          break;
        }
        if (input[i] === '\\' && quote === "'" && i + 1 < input.length) {
          i++;
          current += input[i];
        }
        i++;
      }
      continue;
    }

    if (ch === '(') {
      depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

/**
 * Finds the matching closing parenthesis index for `openIndex`, respecting quotes.
 */
function findMatchingParen(sql: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (i + 1 < sql.length && sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (sql[i] === '\\' && quote === "'" && i + 1 < sql.length) {
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Finds the last top-level occurrence of a SQL keyword (outside quotes and parentheses).
 */
function findLastTopLevelKeyword(sql: string, keyword: string): number {
  const upperSql = sql.toUpperCase();
  const upperKw = keyword.toUpperCase();
  let depth = 0;
  let i = 0;
  let lastIdx = -1;

  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (i + 1 < sql.length && sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (sql[i] === '\\' && quote === "'" && i + 1 < sql.length) {
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
    } else if (depth === 0) {
      const prevOk = i === 0 || !/[a-zA-Z0-9_]/.test(sql[i - 1]);
      const nextIdx = i + upperKw.length;
      const nextOk = nextIdx >= sql.length || !/[a-zA-Z0-9_]/.test(sql[nextIdx]);
      if (prevOk && nextOk && upperSql.startsWith(upperKw, i)) {
        lastIdx = i;
      }
    }
    i++;
  }
  return lastIdx;
}

function isDeterministicKeyExpr(expr: string): boolean {
  const e = expr.trim();
  if (/^\$\d+(?:::[a-zA-Z0-9_\[\]\(\)\s,]+)?$/.test(e)) return true;
  if (/^'[^']*'(?:::[a-zA-Z0-9_\[\]\(\)\s,]+)?$/.test(e)) return true;
  if (/^-?\d+(?:\.\d+)?$/.test(e)) return true;
  return false;
}

interface ParsedInsertReturning {
  table: string;
  columns: string[];
  firstRowValues: string[];
  conflictTargetCols: string[];
  hasOnConflict: boolean;
  returningCols: string;
  sqlWithoutReturning: string;
}

function parseInsertReturning(sql: string): ParsedInsertReturning | null {
  const headerMatch = sql.match(/^\s*INSERT\s+(?:IGNORE\s+)?INTO\s+([a-zA-Z0-9_]+)\s*/i);
  if (!headerMatch) return null;

  const returningIdx = findLastTopLevelKeyword(sql, 'RETURNING');
  if (returningIdx === -1) return null;

  const returningCols = sql.slice(returningIdx + 'RETURNING'.length).trim().replace(/;+\s*$/, '');
  const sqlWithoutReturning = sql.slice(0, returningIdx).trim();
  const table = headerMatch[1].trim();

  let cursor = headerMatch[0].length;
  let columns: string[] = [];
  if (sqlWithoutReturning[cursor] === '(') {
    const closeCols = findMatchingParen(sqlWithoutReturning, cursor);
    if (closeCols !== -1) {
      columns = splitTopLevelSqlList(sqlWithoutReturning.slice(cursor + 1, closeCols)).map((c) =>
        c.replace(/^"|"$/g, '').trim()
      );
      cursor = closeCols + 1;
    }
  }

  let firstRowValues: string[] = [];
  const restAfterCols = sqlWithoutReturning.slice(cursor);
  const firstValuesMatch = restAfterCols.match(/^\s*VALUES\s*\(/i);
  if (firstValuesMatch) {
    const openValIdx = cursor + firstValuesMatch[0].length - 1;
    const closeValIdx = findMatchingParen(sqlWithoutReturning, openValIdx);
    if (closeValIdx !== -1) {
      firstRowValues = splitTopLevelSqlList(sqlWithoutReturning.slice(openValIdx + 1, closeValIdx));
    }
  }

  const onConflictIdx = findLastTopLevelKeyword(sqlWithoutReturning, 'ON');
  let hasOnConflict = false;
  let conflictTargetCols: string[] = [];
  if (onConflictIdx !== -1 && /^ON\s+CONFLICT\b/i.test(sqlWithoutReturning.slice(onConflictIdx))) {
    hasOnConflict = true;
    const conflictTail = sqlWithoutReturning.slice(onConflictIdx);
    const targetMatch = conflictTail.match(/^ON\s+CONFLICT\s*\(([^)]+)\)/i);
    if (targetMatch) {
      conflictTargetCols = splitTopLevelSqlList(targetMatch[1]).map((c) => c.replace(/^"|"$/g, '').trim());
    }
  }

  return {
    table,
    columns,
    firstRowValues,
    conflictTargetCols,
    hasOnConflict,
    returningCols,
    sqlWithoutReturning,
  };
}

/**
 * Translates PostgreSQL queries to MariaDB 10.6 compatible queries:
 * 1. Strips PostgreSQL typecasts (::jsonb, ::uuid, etc.) while preserving string literals (e.g. 'user::jsonb')
 * 2. Translates PostgreSQL functions (clock_timestamp, gen_random_uuid, make_interval, etc.)
 * 3. Translates JSON operators (->> and ->) including table-qualified columns (t.settings->>'key'),
 *    nested paths (custom_fields->'address'->>'city'), and hyphenated keys (custom_fields->>'first-name')
 * 4. Translates PostgreSQL array `= ANY(...)` and `!= ALL(...)` with complex expressions (e.g. COALESCE) to `IN (?)` / `NOT IN (?)`
 * 5. Handles `UPDATE ... RETURNING`, `DELETE ... RETURNING`, and `INSERT ... [ON CONFLICT ...] RETURNING` polyfills
 * 6. Safely converts `ON CONFLICT ... DO NOTHING` using `INSERT IGNORE INTO` when the table does not supply `id`
 * 7. Converts positional parameters ($1, $2, ...) to `?` while preserving correct parameter values
 *    even when parameters are repeated or out of order, and ignoring $N inside string literals.
 */
export function translatePostgresSqlToMariaDb(sql: string, params: any[] = []): TranslatedQuery {
  let translatedSql = sql.trim().replace(/;+\s*$/, '');

  // 1. Check for UPDATE ... RETURNING (supporting optional alias and optional WHERE clause)
  const updateReturningMatch = translatedSql.match(
    /^\s*UPDATE\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?(?!SET\b)([a-zA-Z0-9_]+))?\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+?))?\s+RETURNING\s+([\s\S]+?)$/i
  );

  let isUpdateReturning = false;
  let updateMeta: TranslatedQuery['updateMeta'];
  let isInsertReturning = false;
  let insertMeta: TranslatedQuery['insertMeta'];
  let isDeleteReturning = false;
  let deleteMeta: TranslatedQuery['deleteMeta'];

  if (updateReturningMatch) {
    isUpdateReturning = true;
    const [, table, alias, , rawWhereClause, returningCols] = updateReturningMatch;
    // Strip RETURNING clause for MariaDB execution
    translatedSql = translatedSql.replace(/\s+RETURNING\s+[\s\S]+$/i, '').trim().replace(/;+\s*$/, '');
    const cleanReturning = returningCols.trim().replace(/;+\s*$/, '').trim();
    const cleanWhere = (rawWhereClause || '').trim().replace(/;+\s*$/, '').trim();
    const pkCol = table.trim().toLowerCase() === 'platform_settings' ? 'setting_key' : 'id';

    updateMeta = {
      table: table.trim(),
      ...(alias ? { alias: alias.trim() } : {}),
      returningCols: cleanReturning,
      whereClause: cleanWhere,
      whereParamIndices: [],
      whereParams: [],
      pkCol,
    };
  } else {
    // 1b. Check for DELETE ... RETURNING
    const deleteReturningMatch = translatedSql.match(
      /^\s*DELETE\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?(?!WHERE\b|RETURNING\b)([a-zA-Z0-9_]+))?(?:\s+WHERE\s+([\s\S]+?))?\s+RETURNING\s+([\s\S]+?)$/i
    );
    if (deleteReturningMatch) {
      isDeleteReturning = true;
      const [, table, alias, rawWhereClause, returningCols] = deleteReturningMatch;
      const deleteReturningIdx = findLastTopLevelKeyword(translatedSql, 'RETURNING');
      if (deleteReturningIdx !== -1) {
        translatedSql = translatedSql.slice(0, deleteReturningIdx).trim().replace(/;+\s*$/, '');
      }
      deleteMeta = {
        table: table.trim(),
        ...(alias ? { alias: alias.trim() } : {}),
        returningCols: returningCols.trim().replace(/;+\s*$/, '').trim(),
        whereClause: (rawWhereClause || '').trim().replace(/;+\s*$/, '').trim(),
        whereParams: [],
      };
    } else {
      // 1c. Check for INSERT ... RETURNING
      const parsedInsert = parseInsertReturning(translatedSql);
      if (parsedInsert) {
        isInsertReturning = true;
        const pkCol = parsedInsert.table.toLowerCase() === 'platform_settings' ? 'setting_key' : 'id';
        let rawKeyWhere = '';
        let usesNativeReturning = false;

        if (parsedInsert.columns.length > 0 && parsedInsert.firstRowValues.length === parsedInsert.columns.length) {
          const pkIdx = parsedInsert.columns.findIndex((c) => c.toLowerCase() === pkCol);
          if (pkIdx !== -1 && isDeterministicKeyExpr(parsedInsert.firstRowValues[pkIdx])) {
            rawKeyWhere = `${pkCol} = ${parsedInsert.firstRowValues[pkIdx].trim()}`;
          } else if (parsedInsert.conflictTargetCols.length > 0) {
            const parts: string[] = [];
            let allMatch = true;
            for (const c of parsedInsert.conflictTargetCols) {
              const cIdx = parsedInsert.columns.findIndex((col) => col.toLowerCase() === c.toLowerCase());
              if (cIdx === -1 || !isDeterministicKeyExpr(parsedInsert.firstRowValues[cIdx])) {
                allMatch = false;
                break;
              }
              parts.push(`${c} = ${parsedInsert.firstRowValues[cIdx].trim()}`);
            }
            if (allMatch && parts.length > 0) {
              rawKeyWhere = parts.join(' AND ');
            }
          }
        }

        if (rawKeyWhere || parsedInsert.hasOnConflict) {
          translatedSql = parsedInsert.sqlWithoutReturning;
        } else {
          // MariaDB 10.5+ supports INSERT ... RETURNING natively for DEFAULT (UUID()) / AUTO_INCREMENT rows
          usesNativeReturning = true;
        }

        insertMeta = {
          table: parsedInsert.table,
          returningCols: parsedInsert.returningCols,
          pkCol,
          ...(rawKeyWhere ? { keyWhereClause: rawKeyWhere } : {}),
          keyParams: [],
          hasOnConflict: parsedInsert.hasOnConflict,
          usesNativeReturning,
        };
      }
    }
  }

  // Common dialect transformations: JSON, array membership, functions, typecast stripping
  const applyDialectTransformations = (rawSql: string): string => {
    let s = rawSql;

    // 1. JSON operators (table qualification, hyphenated keys, nested paths, unquote vs extract)
    s = s.replace(
      /(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]+)((?:->(?:'[^']+'|\d+)|->>(?:'[^']+'|\d+))+)/gi,
      (_match, table, col, chain) => {
        const fullCol = table ? `${table}.${col}` : col;
        const isUnquote = /->>(?:'[^']+'|\d+)$/.test(chain);
        let path = '$';
        const segmentRegex = /(->>|->)(?:'([^']+)'|(\d+))/g;
        let seg: RegExpExecArray | null;
        while ((seg = segmentRegex.exec(chain)) !== null) {
          if (seg[2] !== undefined) {
            path += '.' + seg[2];
          } else if (seg[3] !== undefined) {
            path += '[' + seg[3] + ']';
          }
        }
        const extract = `JSON_EXTRACT(${fullCol}, '${path}')`;
        return isUnquote ? `JSON_UNQUOTE(${extract})` : extract;
      }
    );

    // 2. Interval literals with quotes (must be transformed before literal masking)
    s = s
      .replace(/INTERVAL\s+'(\d+)\s+years?'/gi, 'INTERVAL $1 YEAR')
      .replace(/INTERVAL\s+'(\d+)\s+months?'/gi, 'INTERVAL $1 MONTH')
      .replace(/INTERVAL\s+'(\d+)\s+days?'/gi, 'INTERVAL $1 DAY')
      .replace(/INTERVAL\s+'(\d+)\s+hours?'/gi, 'INTERVAL $1 HOUR')
      .replace(/INTERVAL\s+'(\d+)\s+minutes?'/gi, 'INTERVAL $1 MINUTE')
      .replace(/INTERVAL\s+'(\d+)\s+seconds?'/gi, 'INTERVAL $1 SECOND');

    // 3. Translate PostgreSQL ANY($N) and != ALL($N)
    // Negative form: NOT ( <complex expr> = ANY($N) )
    s = s.replace(
      /NOT\s*\(\s*([\s\S]+?)\s*=\s*ANY\s*\(\s*\$([0-9]+)(?:::[\w\[\]]+)?\s*\)\s*\)/gi,
      (_match, expr, num) => `${expr.trim()} NOT IN ($${num})`
    );
    // Positive form: <complex expr> = ANY($N)
    s = s.replace(
      /(?:(\bWHERE\b|\bAND\b|\bOR\b|\()\s+)?((?:(?!\bWHERE\b|\bAND\b|\bOR\b|\().)+?)\s*=\s*ANY\s*\(\s*\$([0-9]+)(?:::[\w\[\]]+)?\s*\)/gi,
      (_match, prefix, expr, num) => {
        const p = prefix ? `${prefix} ` : '';
        return `${p}${expr.trim()} IN ($${num})`;
      }
    );
    // != ALL($N) form: <complex expr> != ALL($N)
    s = s.replace(
      /(?:(\bWHERE\b|\bAND\b|\bOR\b|\()\s+)?((?:(?!\bWHERE\b|\bAND\b|\bOR\b|\().)+?)\s*!=\s*ALL\s*\(\s*\$([0-9]+)(?:::[\w\[\]]+)?\s*\)/gi,
      (_match, prefix, expr, num) => {
        const p = prefix ? `${prefix} ` : '';
        return `${p}${expr.trim()} NOT IN ($${num})`;
      }
    );

    // 4. Mask string literals before typecast stripping to protect literals like 'user::jsonb'
    const literals: string[] = [];
    let masked = '';
    let i = 0;
    const len = s.length;

    while (i < len) {
      const char = s[i];
      if (char === "'") {
        let str = "'";
        i++;
        while (i < len) {
          if (s[i] === "'") {
            str += "'";
            if (i + 1 < len && s[i + 1] === "'") {
              str += "'";
              i += 2;
              continue;
            }
            i++;
            break;
          } else if (s[i] === '\\' && i + 1 < len) {
            str += s[i] + s[i + 1];
            i += 2;
          } else {
            str += s[i];
            i++;
          }
        }
        const tok = `@@_LIT_${literals.length}_@@`;
        literals.push(str);
        masked += tok;
        continue;
      }
      masked += char;
      i++;
    }

    // 5. PostgreSQL functions & syntax on masked SQL
    masked = masked
      .replace(/\bclock_timestamp\(\)/gi, 'CURRENT_TIMESTAMP(6)')
      .replace(/\bgen_random_uuid\(\)/gi, 'UUID()')
      .replace(/make_interval\(hours\s*=>\s*([^)]+)\)/gi, 'INTERVAL $1 HOUR')
      .replace(/make_interval\(days\s*=>\s*([^)]+)\)/gi, 'INTERVAL $1 DAY')
      .replace(/make_interval\(mins?\s*=>\s*([^)]+)\)/gi, 'INTERVAL $1 MINUTE')
      .replace(/\bCOUNT\(\*\)::int\b/gi, 'COUNT(*)')
      // Typecast stripping (supports ::type, ::type(len), ::type[])
      .replace(/::(?:[a-zA-Z0-9_]+)(?:\([0-9\s,]+\))?(?:\[\])?/gi, '')
      .replace(/\bILIKE\b/gi, 'LIKE')
      // ON CONFLICT ... DO NOTHING: only use ON DUPLICATE KEY UPDATE id = id when `id` actually exists in columns/conflict key;
      // otherwise use standard MariaDB `INSERT IGNORE INTO` so tables without `.id` (e.g. platform_settings) never fail.
      .replace(
        /\bINSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*(?:\(([^)]*)\))?((?:(?!\bINSERT\s+INTO\b)[\s\S])*?)\bON\s+CONFLICT\s*(?:\(([^)]*)\)|ON\s+CONSTRAINT\s+[a-zA-Z0-9_]+)?\s*DO\s+NOTHING\b/gi,
        (_m, table, colList, middle, conflictCols) => {
          const hasIdCol =
            (typeof colList === 'string' && /\bid\b/i.test(colList)) ||
            (typeof conflictCols === 'string' && /\bid\b/i.test(conflictCols));
          const colGroup = colList !== undefined ? ` (${colList})` : '';
          if (hasIdCol) {
            return `INSERT INTO ${table}${colGroup}${middle}ON DUPLICATE KEY UPDATE id = id`;
          }
          return `INSERT IGNORE INTO ${table}${colGroup}${middle}`.replace(/\s+$/, '');
        }
      )
      .replace(/ON\s+CONFLICT\s*\([^)]*\)\s*DO\s*UPDATE\s+SET/gi, 'ON DUPLICATE KEY UPDATE')
      .replace(/EXCLUDED\.([a-zA-Z0-9_]+)/gi, 'VALUES($1)')
      .replace(/SELECT\s+pg_advisory_xact_lock\(hashtext\(([^)]+)\)\)/gi, 'SELECT GET_LOCK(MD5($1), 5) AS lock_acquired')
      .replace(/SELECT\s+pg_try_advisory_lock\(hashtext\(([^)]+)\)\)/gi, 'SELECT GET_LOCK($1, 0) AS lock_acquired')
      .replace(/SELECT\s+pg_advisory_unlock\(hashtext\(([^)]+)\)\)/gi, 'SELECT RELEASE_LOCK($1) AS lock_released');

    // 6. Unmask string literals
    return masked.replace(/@@_LIT_(\d+)_@@/g, (_m, idx) => literals[parseInt(idx, 10)] ?? '');
  };

  // Helper to replace $N with ? in an SQL string and extract the corresponding parameters
  const replacePlaceholders = (sqlWithPlaceholders: string, sourceParams: any[]) => {
    const tokens: string[] = [];
    const extractedParams: any[] = [];
    let i = 0;
    const len = sqlWithPlaceholders.length;

    while (i < len) {
      const char = sqlWithPlaceholders[i];

      // Single-quote string literal - preserve intact
      if (char === "'") {
        let strLiteral = "'";
        i++;
        while (i < len) {
          if (sqlWithPlaceholders[i] === "'") {
            strLiteral += "'";
            if (i + 1 < len && sqlWithPlaceholders[i + 1] === "'") {
              strLiteral += "'";
              i += 2;
              continue;
            }
            i++;
            break;
          } else if (sqlWithPlaceholders[i] === '\\' && i + 1 < len) {
            strLiteral += sqlWithPlaceholders[i] + sqlWithPlaceholders[i + 1];
            i += 2;
          } else {
            strLiteral += sqlWithPlaceholders[i];
            i++;
          }
        }
        tokens.push(strLiteral);
        continue;
      }

      // Double-quote identifier
      if (char === '"') {
        let idLiteral = '"';
        i++;
        while (i < len && sqlWithPlaceholders[i] !== '"') {
          idLiteral += sqlWithPlaceholders[i];
          i++;
        }
        if (i < len) {
          idLiteral += '"';
          i++;
        }
        tokens.push(idLiteral);
        continue;
      }

      // Parameter placeholder $1, $2, ...
      if (char === '$' && i + 1 < len && /[0-9]/.test(sqlWithPlaceholders[i + 1])) {
        let numStr = '';
        i++;
        while (i < len && /[0-9]/.test(sqlWithPlaceholders[i])) {
          numStr += sqlWithPlaceholders[i];
          i++;
        }
        const paramIndex = parseInt(numStr, 10) - 1;
        const paramVal = sourceParams[paramIndex];
        extractedParams.push(paramVal);
        tokens.push('?');
        continue;
      }

      tokens.push(char);
      i++;
    }

    return {
      sql: tokens.join(''),
      params: extractedParams,
    };
  };

  // Translate main SQL
  translatedSql = applyDialectTransformations(translatedSql);
  const mainReplaced = replacePlaceholders(translatedSql, params);
  translatedSql = mainReplaced.sql;
  const newParams = mainReplaced.params;

  // If this was an UPDATE ... RETURNING, also clean whereClause and returningCols
  if (isUpdateReturning && updateMeta) {
    if (updateMeta.whereClause) {
      const cleanedWhere = applyDialectTransformations(updateMeta.whereClause);
      const whereReplaced = replacePlaceholders(cleanedWhere, params);
      updateMeta.whereClause = whereReplaced.sql;
      updateMeta.whereParams = whereReplaced.params;
    }
    updateMeta.returningCols = applyDialectTransformations(updateMeta.returningCols)
      .trim()
      .replace(/;+\s*$/, '');
  }

  // If this was a DELETE ... RETURNING, clean whereClause and returningCols
  if (isDeleteReturning && deleteMeta) {
    if (deleteMeta.whereClause) {
      const cleanedWhere = applyDialectTransformations(deleteMeta.whereClause);
      const whereReplaced = replacePlaceholders(cleanedWhere, params);
      deleteMeta.whereClause = whereReplaced.sql;
      deleteMeta.whereParams = whereReplaced.params;
    }
    deleteMeta.returningCols = applyDialectTransformations(deleteMeta.returningCols)
      .trim()
      .replace(/;+\s*$/, '');
  }

  // If this was an INSERT ... RETURNING, clean keyWhereClause and returningCols
  if (isInsertReturning && insertMeta) {
    if (insertMeta.keyWhereClause) {
      const cleanedKeyWhere = applyDialectTransformations(insertMeta.keyWhereClause);
      const keyReplaced = replacePlaceholders(cleanedKeyWhere, params);
      insertMeta.keyWhereClause = keyReplaced.sql;
      insertMeta.keyParams = keyReplaced.params;
    }
    insertMeta.returningCols = applyDialectTransformations(insertMeta.returningCols)
      .trim()
      .replace(/;+\s*$/, '');
  }

  return {
    sql: translatedSql,
    params: newParams,
    isUpdateReturning,
    updateMeta,
    isInsertReturning,
    insertMeta,
    isDeleteReturning,
    deleteMeta,
  };
}
