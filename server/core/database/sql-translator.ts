export interface TranslatedQuery {
  sql: string;
  params: any[];
  isUpdateReturning: boolean;
  updateMeta?: {
    table: string;
    returningCols: string;
    whereClause: string;
    whereParamIndices?: number[];
    whereParams?: any[];
    pkCol?: string;
  };
}

/**
 * Translates PostgreSQL queries to MariaDB 10.6 compatible queries:
 * 1. Strips PostgreSQL typecasts (::jsonb, ::uuid, etc.) while preserving string literals (e.g. 'user::jsonb')
 * 2. Translates PostgreSQL functions (clock_timestamp, gen_random_uuid, make_interval, etc.)
 * 3. Translates JSON operators (->> and ->) including table-qualified columns (t.settings->>'key'),
 *    nested paths (custom_fields->'address'->>'city'), and hyphenated keys (custom_fields->>'first-name')
 * 4. Translates PostgreSQL array `= ANY(...)` and `!= ALL(...)` with complex expressions (e.g. COALESCE) to `IN (?)` / `NOT IN (?)`
 * 5. Handles `UPDATE ... RETURNING` decomposition for MariaDB 10.6, including queries without WHERE clauses,
 *    stripping trailing semicolons, and cleaning typecasts/ILIKE inside WHERE clauses
 * 6. Converts positional parameters ($1, $2, ...) to `?` while preserving correct parameter values
 *    even when parameters are repeated or out of order, and ignoring $N inside string literals.
 */
export function translatePostgresSqlToMariaDb(sql: string, params: any[] = []): TranslatedQuery {
  let translatedSql = sql.trim().replace(/;+\s*$/, '');

  // 1. Check for UPDATE ... RETURNING (supporting optional WHERE clause and optional trailing semicolon)
  const updateReturningMatch = translatedSql.match(
    /^\s*UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+?))?\s+RETURNING\s+([\s\S]+?)$/i
  );

  let isUpdateReturning = false;
  let updateMeta: TranslatedQuery['updateMeta'];

  if (updateReturningMatch) {
    isUpdateReturning = true;
    const [, table, , rawWhereClause, returningCols] = updateReturningMatch;
    // Strip RETURNING clause for MariaDB execution
    translatedSql = translatedSql.replace(/\s+RETURNING\s+[\s\S]+$/i, '').trim().replace(/;+\s*$/, '');
    const cleanReturning = returningCols.trim().replace(/;+\s*$/, '').trim();
    const cleanWhere = (rawWhereClause || '').trim().replace(/;+\s*$/, '').trim();
    const pkCol = table.trim().toLowerCase() === 'platform_settings' ? 'setting_key' : 'id';

    updateMeta = {
      table: table.trim(),
      returningCols: cleanReturning,
      whereClause: cleanWhere,
      whereParamIndices: [],
      whereParams: [],
      pkCol,
    };
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
      .replace(/INTERVAL\s+'(\d+)\s+days?'/gi, 'INTERVAL $1 DAY')
      .replace(/INTERVAL\s+'(\d+)\s+hours?'/gi, 'INTERVAL $1 HOUR')
      .replace(/INTERVAL\s+'(\d+)\s+minutes?'/gi, 'INTERVAL $1 MINUTE');

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
      .replace(/\bCOUNT\(\*\)::int\b/gi, 'COUNT(*)')
      // Typecast stripping (supports ::type, ::type(len), ::type[])
      .replace(/::(?:[a-zA-Z0-9_]+)(?:\([0-9\s,]+\))?(?:\[\])?/gi, '')
      .replace(/\bILIKE\b/gi, 'LIKE')
      .replace(/ON\s+CONFLICT\s*\([^)]*\)\s*DO\s*NOTHING/gi, 'ON DUPLICATE KEY UPDATE id = id')
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

  return {
    sql: translatedSql,
    params: newParams,
    isUpdateReturning,
    updateMeta,
  };
}
