/**
 * Удаление тестовых записей из таблицы files (добавленных через seed-data.js).
 * Запуск: node clear-test-data.js
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(path.resolve(__dirname), 'database', 'files.db');
const db = new sqlite3.Database(dbPath);

db.run("DELETE FROM files WHERE stored_name LIKE 'test_%'", function(err) {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log('Удалено тестовых записей:', this.changes);
  db.close();
});
