import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMigration } from '../lib/parser.mjs';

test('detects foreign key lock hazard and generates NOT VALID + VALIDATE CONSTRAINT', () => {
  const sql = `ALTER TABLE orders ADD CONSTRAINT fk_orders_users FOREIGN KEY (user_id) REFERENCES users(id);`;
  const result = analyzeMigration(sql);

  assert.equal(result.isSafe, false);
  assert.equal(result.hazardCount, 1);
  assert.equal(result.hazards[0].rule, 'FOREIGN_KEY_LOCK');
  assert.match(result.transpiledSql.phase1, /ADD CONSTRAINT fk_orders_users FOREIGN KEY \(user_id\) REFERENCES users\(id\) NOT VALID;/);
  assert.match(result.transpiledSql.phase2, /ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_users;/);
});

test('detects check constraint lock hazard and generates NOT VALID + VALIDATE CONSTRAINT', () => {
  const sql = `ALTER TABLE products ADD CONSTRAINT chk_price CHECK (price >= 0);`;
  const result = analyzeMigration(sql);

  assert.equal(result.isSafe, false);
  assert.equal(result.hazardCount, 1);
  assert.equal(result.hazards[0].rule, 'CHECK_CONSTRAINT_LOCK');
  assert.match(result.transpiledSql.phase1, /ADD CONSTRAINT chk_price CHECK \(price >= 0\) NOT VALID;/);
  assert.match(result.transpiledSql.phase2, /ALTER TABLE products VALIDATE CONSTRAINT chk_price;/);
});

test('detects non-concurrent index creation and transforms to CONCURRENTLY', () => {
  const sql = `CREATE INDEX idx_users_email ON users (email);`;
  const result = analyzeMigration(sql);

  assert.equal(result.isSafe, false);
  assert.equal(result.hazardCount, 1);
  assert.equal(result.hazards[0].rule, 'NON_CONCURRENT_INDEX');
  assert.match(result.transpiledSql.phase1, /CREATE INDEX CONCURRENTLY idx_users_email ON users \(email\);/);
});

test('detects non-concurrent unique index creation', () => {
  const sql = `CREATE UNIQUE INDEX idx_orgs_slug ON organizations (slug);`;
  const result = analyzeMigration(sql);

  assert.equal(result.isSafe, false);
  assert.equal(result.hazardCount, 1);
  assert.equal(result.hazards[0].rule, 'NON_CONCURRENT_INDEX');
  assert.match(result.transpiledSql.phase1, /CREATE UNIQUE INDEX CONCURRENTLY idx_orgs_slug ON organizations \(slug\);/);
});

test('detects non-concurrent drop index', () => {
  const sql = `DROP INDEX idx_old_metric;`;
  const result = analyzeMigration(sql);

  assert.equal(result.isSafe, false);
  assert.equal(result.hazardCount, 1);
  assert.equal(result.hazards[0].rule, 'NON_CONCURRENT_DROP_INDEX');
  assert.match(result.transpiledSql.phase1, /DROP INDEX CONCURRENTLY IF EXISTS idx_old_metric;/);
});

test('passes safe migration statements with zero hazards', () => {
  const safeSql = `
    -- Safe migration
    ALTER TABLE users ADD COLUMN bio text;
    CREATE INDEX CONCURRENTLY idx_users_created ON users (created_at);
  `;
  const result = analyzeMigration(safeSql);

  assert.equal(result.isSafe, true);
  assert.equal(result.hazardCount, 0);
  assert.equal(result.hazards.length, 0);
});
