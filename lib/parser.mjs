/**
 * SafeDDL Core Parser Engine
 * Analyzes PostgreSQL DDL statements for lock-contention hazards and generates non-blocking 3-phase migrations.
 */

export const HAZARD_TYPES = {
  ACCESS_EXCLUSIVE: 'ACCESS EXCLUSIVE',
  SHARE_ROW_EXCLUSIVE: 'SHARE ROW EXCLUSIVE',
  SHARE: 'SHARE'
};

export function analyzeMigration(sql) {
  const hazards = [];
  const phase1 = []; // Instant metadata locks (0ms hold time)
  const phase2 = []; // Asynchronous background validation (non-blocking)
  const warnings = [];

  const lines = sql.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    const lineNum = i + 1;

    if (!line || line.startsWith('--')) {
      continue;
    }

    // If already validated asynchronously or already created with NOT VALID, it's safe
    if (/VALIDATE\s+CONSTRAINT/i.test(line)) {
      phase2.push(line);
      continue;
    }

    // 1. ADD CONSTRAINT ... FOREIGN KEY
    if (/ALTER\s+TABLE\s+([^\s]+)\s+ADD\s+CONSTRAINT\s+([^\s]+)\s+FOREIGN\s+KEY/i.test(line)) {
      if (/NOT\s+VALID/i.test(line)) {
        phase1.push(line);
        continue;
      }
      const match = line.match(/ALTER\s+TABLE\s+([^\s]+)\s+ADD\s+CONSTRAINT\s+([^\s]+)\s+FOREIGN\s+KEY\s*(.*)/i);
      const table = match[1];
      const constraint = match[2];
      const rest = match[3].replace(/;$/, '');

      hazards.push({
        line: lineNum,
        type: HAZARD_TYPES.ACCESS_EXCLUSIVE,
        rule: 'FOREIGN_KEY_LOCK',
        table,
        constraint,
        message: `Adding foreign key '${constraint}' on table '${table}' scans every row under ACCESS EXCLUSIVE lock, blocking all concurrent SELECT and write queries.`
      });

      phase1.push(`-- [Phase 1: Zero-lock metadata creation]\nALTER TABLE ${table} ADD CONSTRAINT ${constraint} FOREIGN KEY ${rest} NOT VALID;`);
      phase2.push(`-- [Phase 2: Asynchronous background validation]\nALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint};`);
      continue;
    }

    // 2. ADD CONSTRAINT ... CHECK
    if (/ALTER\s+TABLE\s+([^\s]+)\s+ADD\s+CONSTRAINT\s+([^\s]+)\s+CHECK/i.test(line)) {
      if (/NOT\s+VALID/i.test(line)) {
        phase1.push(line);
        continue;
      }
      const match = line.match(/ALTER\s+TABLE\s+([^\s]+)\s+ADD\s+CONSTRAINT\s+([^\s]+)\s+CHECK\s*(.*)/i);
      const table = match[1];
      const constraint = match[2];
      const rest = match[3].replace(/;$/, '');

      hazards.push({
        line: lineNum,
        type: HAZARD_TYPES.ACCESS_EXCLUSIVE,
        rule: 'CHECK_CONSTRAINT_LOCK',
        table,
        constraint,
        message: `Adding CHECK constraint '${constraint}' on table '${table}' holds an exclusive lock while validating all rows.`
      });

      phase1.push(`-- [Phase 1: Zero-lock metadata creation]\nALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK ${rest} NOT VALID;`);
      phase2.push(`-- [Phase 2: Asynchronous background validation]\nALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint};`);
      continue;
    }

    // 3. CREATE INDEX without CONCURRENTLY
    if (/CREATE\s+(UNIQUE\s+)?INDEX\s+([^\s]+)\s+ON\s+([^\s(]+)(.*)/i.test(line) && !/CONCURRENTLY/i.test(line)) {
      const match = line.match(/CREATE\s+(UNIQUE\s+)?INDEX\s+([^\s]+)\s+ON\s+([^\s(]+)(.*)/i);
      const isUnique = match[1] || '';
      const indexName = match[2];
      const table = match[3];
      const rest = (match[4] || '').replace(/;$/, '');

      hazards.push({
        line: lineNum,
        type: HAZARD_TYPES.SHARE,
        rule: 'NON_CONCURRENT_INDEX',
        table,
        indexName,
        message: `CREATE ${isUnique ? 'UNIQUE ' : ''}INDEX on table '${table}' acquires SHARE lock, blocking all concurrent INSERT, UPDATE, and DELETE queries during the index build.`
      });

      phase1.push(`-- [Non-blocking concurrent index build (must run outside single transaction)]\nCREATE ${isUnique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY ${indexName} ON ${table}${rest};`);
      continue;
    }

    // 4. DROP INDEX without CONCURRENTLY
    if (/DROP\s+INDEX\s+([^\s;]+)/i.test(line) && !/CONCURRENTLY/i.test(line)) {
      const match = line.match(/DROP\s+INDEX\s+([^\s;]+)/i);
      const indexName = match[1];

      hazards.push({
        line: lineNum,
        type: HAZARD_TYPES.ACCESS_EXCLUSIVE,
        rule: 'NON_CONCURRENT_DROP_INDEX',
        indexName,
        message: `DROP INDEX on '${indexName}' blocks concurrent queries. Use DROP INDEX CONCURRENTLY.`
      });

      phase1.push(`-- [Non-blocking concurrent index removal]\nDROP INDEX CONCURRENTLY IF EXISTS ${indexName};`);
      continue;
    }

    // 5. ADD COLUMN with NOT NULL without DEFAULT (or pre-PG11 default lock)
    if (/ALTER\s+TABLE\s+([^\s]+)\s+ADD\s+COLUMN\s+([^\s]+)\s+([^;]+)\s+NOT\s+NULL/i.test(line)) {
      const match = line.match(/ALTER\s+TABLE\s+([^\s]+)\s+ADD\s+COLUMN\s+([^\s]+)\s+([^;]+)\s+NOT\s+NULL(.*)/i);
      const table = match[1];
      const colName = match[2];
      const colType = match[3].trim();
      const hasDefault = /DEFAULT/i.test(line);

      if (!hasDefault) {
        hazards.push({
          line: lineNum,
          type: HAZARD_TYPES.ACCESS_EXCLUSIVE,
          rule: 'NOT_NULL_COLUMN_WITHOUT_DEFAULT',
          table,
          column: colName,
          message: `Adding a NOT NULL column without a DEFAULT will fail if table '${table}' contains existing rows, or rewrite table under ACCESS EXCLUSIVE.`
        });

        phase1.push(`-- [Phase 1: Add column as nullable]\nALTER TABLE ${table} ADD COLUMN ${colName} ${colType};\n-- Add check constraint not valid\nALTER TABLE ${table} ADD CONSTRAINT ${table}_${colName}_not_null CHECK (${colName} IS NOT NULL) NOT VALID;`);
        phase2.push(`-- [Phase 2: Validate constraint asynchronously]\nALTER TABLE ${table} VALIDATE CONSTRAINT ${table}_${colName}_not_null;`);
        continue;
      }
    }

    // If safe, keep in phase 1
    phase1.push(line);
  }

  return {
    isSafe: hazards.length === 0,
    hazardCount: hazards.length,
    hazards,
    transpiledSql: {
      phase1: phase1.join('\n'),
      phase2: phase2.join('\n')
    }
  };
}
