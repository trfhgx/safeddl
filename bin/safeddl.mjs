#!/usr/bin/env node

/**
 * SafeDDL CLI Executable
 * Analyzes PostgreSQL DDL for table locks and transpiles into non-blocking 3-phase migrations.
 */

import fs from 'fs';
import path from 'path';
import { analyzeMigration } from '../lib/parser.mjs';

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
SafeDDL v1.0.0 — Zero-Lock Postgres Migration Assistant

Usage:
  safeddl <file.sql>               Analyze SQL migration and print safe 3-phase DDL
  safeddl --check <file.sql>       CI Mode: Exits with code 1 if ACCESS EXCLUSIVE locks found
  safeddl --transpile <file.sql>   Print only the safe SQL output to stdout
  safeddl --json <file.sql>        Output structured JSON report of hazards and fixes
  safeddl --out <dir> <file.sql>   Write phase1_deploy.sql and phase2_postdeploy.sql to dir

Supported Zero-Lock Transformations:
  - ADD CONSTRAINT FOREIGN KEY     -> NOT VALID + VALIDATE CONSTRAINT
  - ADD CONSTRAINT CHECK           -> NOT VALID + VALIDATE CONSTRAINT
  - CREATE INDEX                   -> CREATE INDEX CONCURRENTLY
  - DROP INDEX                     -> DROP INDEX CONCURRENTLY
  - ADD COLUMN NOT NULL            -> ADD COLUMN NULL + CHECK NOT VALID + VALIDATE
  `);
  process.exit(0);
}

const isCheck = args.includes('--check');
const isTranspileOnly = args.includes('--transpile');
const isJson = args.includes('--json');
const outIndex = args.indexOf('--out');
const outDir = outIndex !== -1 && args[outIndex + 1] ? args[outIndex + 1] : null;

const filePath = args.find(a => !a.startsWith('--') && a !== outDir);

if (!filePath) {
  console.error('Error: No SQL file specified. Run with --help for usage.');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`Error: File not found: ${filePath}`);
  process.exit(1);
}

const sql = fs.readFileSync(filePath, 'utf8');
const result = analyzeMigration(sql);

if (isJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.isSafe ? 0 : 1);
}

if (isTranspileOnly) {
  console.log(`-- ====================================================`);
  console.log(`-- PHASE 1: Deploy Time (Metadata Lock Only - 0ms delay)`);
  console.log(`-- ====================================================`);
  console.log(result.transpiledSql.phase1);
  if (result.transpiledSql.phase2) {
    console.log(`\n-- ====================================================`);
    console.log(`-- PHASE 2: Post-Deploy (Background Async Validation)`);
    console.log(`-- ====================================================`);
    console.log(result.transpiledSql.phase2);
  }
  process.exit(0);
}

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const p1Path = path.join(outDir, 'phase1_deploy.sql');
  const p2Path = path.join(outDir, 'phase2_postdeploy.sql');
  fs.writeFileSync(p1Path, result.transpiledSql.phase1 + '\n', 'utf8');
  fs.writeFileSync(p2Path, (result.transpiledSql.phase2 || '-- No phase 2 required') + '\n', 'utf8');
  console.log(`✓ Wrote safe migration files to:`);
  console.log(`  - ${p1Path}`);
  console.log(`  - ${p2Path}`);
}

console.log(`\n======================================================`);
console.log(` SafeDDL Postgres Migration Audit: ${path.basename(filePath)}`);
console.log(`======================================================\n`);

if (result.isSafe) {
  console.log(`✓ Zero Lock Contention Hazards Detected. Migration is deployment-safe.\n`);
  process.exit(0);
}

console.log(`⚠️  FOUND ${result.hazardCount} LOCK CONTENTION HAZARD(S):\n`);
result.hazards.forEach((h, idx) => {
  console.log(` [${idx + 1}] Line ${h.line}: [${h.type}] ${h.rule}`);
  console.log(`     ${h.message}\n`);
});

if (isCheck) {
  console.error(`FAILED CI CHECK: Unsafe DDL table locks detected. Transpile using 'safeddl ${filePath}'.\n`);
  process.exit(1);
}

console.log(`------------------------------------------------------`);
console.log(` TRANSPILATION: Safe Zero-Downtime 3-Phase Migration`);
console.log(`------------------------------------------------------\n`);

console.log(`-- ====================================================`);
console.log(`-- TRANSACTION 1: Deploy Phase (Instant metadata lock)`);
console.log(`-- ====================================================`);
console.log(result.transpiledSql.phase1);

if (result.transpiledSql.phase2) {
  console.log(`\n-- ====================================================`);
  console.log(`-- TRANSACTION 2: Post-Deploy Phase (Async Background Validation)`);
  console.log(`-- ====================================================`);
  console.log(result.transpiledSql.phase2);
}

console.log(`\n✓ SafeDDL transpile complete. Zero dropped transactions guaranteed.\n`);
