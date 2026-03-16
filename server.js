require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;

// ------ Определяем корневую папку приложения ------
const appRoot = process.env.PKG 
  ? path.dirname(process.execPath) 
  : path.resolve(__dirname);

console.log('Корневая папка приложения:', appRoot);

// ------ Пароль для добавления новых пользователей (из .env) ------
const ADD_USER_PASSWORD = process.env.ADD_USER_PASSWORD || '545';

// Пути к папкам для данных
const uploadDir = path.join(appRoot, 'uploads');
const dbDir = path.join(appRoot, 'database');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log('Создана папка для загрузок:', uploadDir);
}

// ------ Подключение к PostgreSQL ------
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'exostart',
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Ошибка подключения к PostgreSQL:', err.stack);
    process.exit(1);
  } else {
    console.log('✅ Подключено к PostgreSQL');
    release();
  }
});

// ------ Инициализация таблиц ------
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        image_name TEXT,
        uploader TEXT NOT NULL,
        upload_date TEXT NOT NULL,
        downloaded BOOLEAN DEFAULT FALSE,
        downloaded_by TEXT,
        downloaded_date TEXT,
        milled BOOLEAN DEFAULT FALSE,
        baked BOOLEAN DEFAULT FALSE,
        comment TEXT
      )
    `);
    console.log('Таблица files проверена/создана');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      )
    `);
    console.log('Таблица users проверена/создана');

    const checkAndAddColumn = async (table, column, definition) => {
      const res = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = $1 AND column_name = $2
      `, [table, column]);
      if (res.rows.length === 0) {
        await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`Колонка ${column} добавлена в таблицу ${table}`);
      }
    };

    await checkAndAddColumn('files', 'image_name', 'TEXT');
    await checkAndAddColumn('files', 'milled', 'BOOLEAN DEFAULT FALSE');
    await checkAndAddColumn('files', 'baked', 'BOOLEAN DEFAULT FALSE');
    await checkAndAddColumn('files', 'comment', 'TEXT');

    const userCount = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCount.rows[0].count) === 0) {
      const defaultUsers = [
        'София', 'Анна', 'Маргарита', 'Слава', 'Егор',
        'Наталья', 'Мария', 'Сухроб', 'Абу', 'Альберт', 'Юлия'
      ];
      for (const name of defaultUsers) {
        await pool.query('INSERT INTO users (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
      }
      console.log('Добавлены начальные пользователи');
    }
  } catch (err) {
    console.error('Ошибка инициализации БД:', err);
    process.exit(1);
  }
}
initDb();

// ------ Настройка Express ------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  const isFileRoute = req.path.startsWith('/image/') || req.path.startsWith('/download');
  if (!isFileRoute) {
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  }
  next();
});
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(appRoot, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(appRoot, 'views'));

// ------ Multer для загрузки файлов ------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(uploadDir, req.session.user);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safeName = path.basename(decodedName);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const uniqueName = uniqueSuffix + '-' + safeName;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage: storage });

// ------ Middleware авторизации ------
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/set-user' || req.path.startsWith('/public')) {
    return next();
  }
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
});

// ------ Маршруты ------

// Страница входа
app.get('/login', async (req, res) => {
  try {
    const result = await pool.query('SELECT name FROM users ORDER BY name');
    const users = result.rows.map(row => row.name);
    res.render('login', { users });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка БД');
  }
});

app.post('/set-user', async (req, res) => {
  const username = req.body.username;
  try {
    const result = await pool.query('SELECT name FROM users WHERE name = $1', [username]);
    if (result.rows.length === 0) {
      return res.redirect('/login');
    }
    req.session.user = username;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.redirect('/login');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Главная страница (с перенаправлением для Елены и динамическим поиском)
app.get('/', async (req, res) => {
  if (req.session.user === 'Елена') {
    return res.redirect('/titan');
  }

  const { date, uploader, downloaded, filename } = req.query;

  let sql = 'SELECT * FROM files';
  const params = [];
  const conditions = [];

  if (date) {
    conditions.push('date(upload_date) = $' + (params.length + 1));
    params.push(date);
  }
  if (uploader) {
    conditions.push('uploader = $' + (params.length + 1));
    params.push(uploader);
  }
  if (downloaded !== undefined && downloaded !== '') {
    conditions.push('downloaded = $' + (params.length + 1));
    params.push(downloaded === 'true');
  }
  if (filename && filename.trim() !== '') {
    conditions.push('original_name ILIKE $' + (params.length + 1));
    params.push('%' + filename + '%');
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY upload_date DESC';

  try {
    const filesResult = await pool.query(sql, params);
    const files = filesResult.rows;

    const today = new Date().toISOString().slice(0, 10);
    const monthNames = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
    const monthNamesGen = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const byMonth = {};
    files.forEach(f => {
      const d = (f.upload_date || '').slice(0, 10);
      if (!d) return;
      const [y, m] = d.split('-').map(Number);
      const monthKey = `${y}-${String(m).padStart(2, '0')}`;
      if (!byMonth[monthKey]) {
        byMonth[monthKey] = { monthKey, monthLabel: `${monthNames[m - 1]} ${y}`, days: {} };
      }
      if (!byMonth[monthKey].days[d]) {
        byMonth[monthKey].days[d] = { dateKey: d, isToday: d === today, files: [] };
      }
      byMonth[monthKey].days[d].files.push(f);
    });
    const groupedFiles = Object.keys(byMonth)
      .sort((a, b) => b.localeCompare(a))
      .map(k => {
        const month = byMonth[k];
        const dayKeys = Object.keys(month.days).sort((a, b) => b.localeCompare(a));
        month.daysList = dayKeys.map(dk => {
          const day = month.days[dk];
          const [, mm, dd] = dk.split('-');
          const mi = parseInt(mm, 10) - 1;
          day.dayLabel = `${parseInt(dd, 10)} ${monthNamesGen[mi]} ${month.monthLabel.split(' ')[1]}`;
          return day;
        });
        return month;
      });

    const uploadersResult = await pool.query('SELECT DISTINCT uploader FROM files');
    const uploaders = uploadersResult.rows.map(row => row.uploader);

    res.render('index', {
      files,
      groupedFiles,
      todayKey: today,
      users: uploaders,
      currentUser: req.session.user,
      filters: { date, uploader, downloaded, filename }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка базы данных');
  }
});

// Загрузка файлов
app.post('/upload', upload.fields([
  { name: 'stlFiles', maxCount: 20 },
  { name: 'imageFile', maxCount: 1 }
]), async (req, res) => {
  if (!req.files || !req.files['stlFiles'] || req.files['stlFiles'].length === 0) {
    return res.status(400).send('Не выбрано ни одного 3D-файла.');
  }

  const stlFiles = req.files['stlFiles'];
  const imageFile = req.files['imageFile'] ? req.files['imageFile'][0] : null;
  let imageName = imageFile ? imageFile.filename : null;

  const uploader = req.session.user;
  const uploadDate = new Date().toISOString();
  const milled = req.body.milled === 'on';
  const baked = req.body.baked === 'on';
  const comment = req.body.comment || '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const stlFile of stlFiles) {
      const decodedStlName = Buffer.from(stlFile.originalname, 'latin1').toString('utf8');
      const storedStlName = stlFile.filename;
      await client.query(
        `INSERT INTO files 
         (original_name, stored_name, image_name, uploader, upload_date, downloaded, milled, baked, comment) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [decodedStlName, storedStlName, imageName, uploader, uploadDate, false, milled, baked, comment]
      );
    }
    await client.query('COMMIT');
    res.redirect('/');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Ошибка при загрузке файлов:', err);
    res.status(500).send('Ошибка при сохранении в БД.');
  } finally {
    client.release();
  }
});

// Скачивание 3D-файла
app.get('/download/:id', async (req, res) => {
  const fileId = req.params.id;
  const downloader = req.session.user;

  try {
    const fileResult = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    if (fileResult.rows.length === 0) {
      return res.status(404).send('Файл не найден.');
    }
    const file = fileResult.rows[0];

    const updateDownloaders = (currentList, newUser) => {
      if (!currentList) return newUser;
      const users = currentList.split(',').map(u => u.trim());
      if (users.includes(newUser)) return currentList;
      return currentList + ', ' + newUser;
    };

    if (!file.downloaded) {
      const downloadDate = new Date().toISOString();
      await pool.query(
        'UPDATE files SET downloaded = TRUE, downloaded_by = $1, downloaded_date = $2 WHERE id = $3',
        [downloader, downloadDate, fileId]
      );
    } else {
      const newList = updateDownloaders(file.downloaded_by, downloader);
      if (newList !== file.downloaded_by) {
        await pool.query(
          'UPDATE files SET downloaded_by = $1 WHERE id = $2',
          [newList, fileId]
        );
      }
    }

    const filePath = path.join(uploadDir, file.uploader, file.stored_name);
    res.download(filePath, file.original_name);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

// MIME-типы для изображений
const imageMime = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
};

// Просмотр изображения
app.get('/image/:id', async (req, res) => {
  const fileId = req.params.id;
  try {
    const result = await pool.query('SELECT image_name, uploader FROM files WHERE id = $1', [fileId]);
    if (result.rows.length === 0 || !result.rows[0].image_name) {
      return res.status(404).send('Изображение не найдено.');
    }
    const file = result.rows[0];
    const imagePath = path.join(uploadDir, file.uploader, file.image_name);
    const ext = path.extname(file.image_name).toLowerCase();
    const contentType = imageMime[ext] || 'image/png';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(imagePath);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

// Скачивание изображения
app.get('/download-image/:id', async (req, res) => {
  const fileId = req.params.id;
  try {
    const result = await pool.query('SELECT image_name, uploader, original_name FROM files WHERE id = $1', [fileId]);
    if (result.rows.length === 0 || !result.rows[0].image_name) {
      return res.status(404).send('Изображение не найдено.');
    }
    const file = result.rows[0];
    const imagePath = path.join(uploadDir, file.uploader, file.image_name);
    res.download(imagePath, file.original_name);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

// Удаление файла
app.post('/delete/:id', async (req, res) => {
  const fileId = req.params.id;
  const { code } = req.body;

  if (code !== '78') {
    return res.status(403).send('Неверный код');
  }

  try {
    const fileResult = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    if (fileResult.rows.length === 0) {
      return res.status(404).send('Файл не найден');
    }
    const file = fileResult.rows[0];

    const stlPath = path.join(uploadDir, file.uploader, file.stored_name);
    fs.unlink(stlPath, (err) => {
      if (err) console.error('Ошибка удаления STL:', err);
    });

    if (file.image_name) {
      const imagePath = path.join(uploadDir, file.uploader, file.image_name);
      fs.unlink(imagePath, (err) => {
        if (err) console.error('Ошибка удаления изображения:', err);
      });
    }

    await pool.query('DELETE FROM files WHERE id = $1', [fileId]);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка при удалении из БД');
  }
});

// Переключение статусов
app.post('/toggle-milled/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).send('Не авторизован');
  try {
    await pool.query('UPDATE files SET milled = NOT milled WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка БД');
  }
});

app.post('/toggle-baked/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).send('Не авторизован');
  try {
    await pool.query('UPDATE files SET baked = NOT baked WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка БД');
  }
});

app.post('/comment/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).send('Не авторизован');
  const { comment } = req.body;
  try {
    await pool.query('UPDATE files SET comment = $1 WHERE id = $2', [comment, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка БД');
  }
});

// Страница добавления пользователя
app.get('/add-user', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('add-user', { error: null });
});

app.post('/add-user', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { password, newUsername } = req.body;
  if (password !== ADD_USER_PASSWORD) {
    return res.render('add-user', { error: 'Неверный пароль' });
  }

  if (!newUsername || newUsername.trim() === '') {
    return res.render('add-user', { error: 'Имя не может быть пустым' });
  }

  try {
    await pool.query('INSERT INTO users (name) VALUES ($1)', [newUsername.trim()]);
    res.redirect('/');
  } catch (err) {
    if (err.code === '23505') {
      return res.render('add-user', { error: 'Пользователь с таким именем уже существует' });
    }
    console.error(err);
    res.render('add-user', { error: 'Ошибка базы данных' });
  }
});

// ===== МАРШРУТЫ ДЛЯ УЧЁТА ТИТАНОВЫХ ОСНОВАНИЙ =====

// Страница со списком оснований
app.get('/titan', async (req, res) => {
  try {
    const { order_number, status, date_from, date_to } = req.query;
    let sql = 'SELECT * FROM titan_orders';
    const params = [];
    const conditions = [];

    if (order_number && order_number.trim() !== '') {
      conditions.push(`order_number ILIKE $${params.length + 1}`);
      params.push(`%${order_number}%`);
    }
    if (status && status !== 'all') {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    if (date_from) {
      conditions.push(`order_date >= $${params.length + 1}`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`order_date <= $${params.length + 1}`);
      params.push(date_to);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY order_date DESC, created_at DESC';

    const result = await pool.query(sql, params);
    const orders = result.rows;

    const today = new Date().toISOString().slice(0, 10);
    const monthNames = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
    const monthNamesGen = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const byMonth = {};

    orders.forEach(o => {
      let dateStr = o.order_date;
      if (!dateStr) return;
      if (typeof dateStr === 'object' && dateStr.toISOString) {
        dateStr = dateStr.toISOString().slice(0, 10);
      } else {
        dateStr = String(dateStr).slice(0, 10);
      }
      const [y, m] = dateStr.split('-').map(Number);
      const monthKey = `${y}-${String(m).padStart(2, '0')}`;
      if (!byMonth[monthKey]) {
        byMonth[monthKey] = { monthKey, monthLabel: `${monthNames[m-1]} ${y}`, days: {} };
      }
      if (!byMonth[monthKey].days[dateStr]) {
        byMonth[monthKey].days[dateStr] = { dateKey: dateStr, isToday: dateStr === today, orders: [] };
      }
      byMonth[monthKey].days[dateStr].orders.push(o);
    });

    const groupedOrders = Object.keys(byMonth)
      .sort((a, b) => b.localeCompare(a))
      .map(k => {
        const month = byMonth[k];
        const dayKeys = Object.keys(month.days).sort((a, b) => b.localeCompare(a));
        month.daysList = dayKeys.map(dk => {
          const day = month.days[dk];
          const [, mm, dd] = dk.split('-');
          const mi = parseInt(mm, 10) - 1;
          day.dayLabel = `${parseInt(dd, 10)} ${monthNamesGen[mi]} ${month.monthLabel.split(' ')[1]}`;
          return day;
        });
        return month;
      });

    const isElena = (req.session.user === 'Елена');

    res.render('titan', {
      orders: orders,
      groupedOrders: groupedOrders,
      todayKey: today,
      currentUser: req.session.user,
      isElena: isElena,
      filters: { order_number, status, date_from, date_to }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка базы данных');
  }
});

// Добавление записей (несколько позиций)
app.post('/titan/add', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { order_date, order_number, items } = req.body;
  let itemsArray = [];
  if (items) {
    if (Array.isArray(items)) {
      itemsArray = items;
    } else {
      itemsArray = [items];
    }
  } else {
    const { system_name, size, has_hex } = req.body;
    if (system_name && size) {
      itemsArray.push({ system_name, size, has_hex: has_hex === 'on' });
    }
  }

  if (itemsArray.length === 0) {
    return res.status(400).send('Нет данных для добавления');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of itemsArray) {
      const sizeValue = parseFloat(item.size);
      if (isNaN(sizeValue)) {
        throw new Error(`Некорректное значение размера: ${item.size}`);
      }
      await client.query(
        `INSERT INTO titan_orders 
         (order_date, order_number, system_name, size, has_hex, created_by) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          order_date || new Date().toISOString().slice(0,10),
          order_number,
          item.system_name,
          sizeValue,
          item.has_hex === true || item.has_hex === 'on',
          req.session.user
        ]
      );
    }
    await client.query('COMMIT');
    res.redirect('/titan');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Ошибка при добавлении:', err);
    res.status(500).send('Ошибка при добавлении: ' + err.message);
  } finally {
    client.release();
  }
});

// Переключение статуса (только Елена)
app.post('/titan/toggle-status/:id', async (req, res) => {
  if (req.session.user !== 'Елена') {
    return res.status(403).json({ success: false, message: 'Доступ запрещён' });
  }
  const id = req.params.id;
  try {
    const current = await pool.query('SELECT status FROM titan_orders WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ success: false });
    const newStatus = current.rows[0].status === 'pending' ? 'issued' : 'pending';
    await pool.query('UPDATE titan_orders SET status = $1 WHERE id = $2', [newStatus, id]);
    res.json({ success: true, newStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// Экспорт в Excel
app.get('/titan/export', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM titan_orders ORDER BY order_date, order_number');
    const rows = result.rows;

    const groups = {};
    rows.forEach(row => {
      let dateStr = row.order_date;
      if (typeof dateStr === 'object' && dateStr.toISOString) {
        dateStr = dateStr.toISOString().slice(0, 10);
      } else {
        dateStr = String(dateStr).slice(0, 10);
      }
      const key = `${row.order_number}_${row.system_name}_${row.size}_${row.has_hex}`;
      if (!groups[key]) {
        groups[key] = {
          order_date: dateStr,
          order_number: row.order_number,
          system_name: row.system_name,
          size: row.size,
          has_hex: row.has_hex ? 'Да' : 'Нет',
          count: 0
        };
      }
      groups[key].count++;
    });

    const data = Object.values(groups).sort((a, b) => {
      if (a.order_number !== b.order_number) return a.order_number.localeCompare(b.order_number);
      return a.order_date.localeCompare(b.order_date);
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Титановые основания');

    worksheet.columns = [
      { header: 'Дата', key: 'order_date', width: 12 },
      { header: 'Наряд', key: 'order_number', width: 15 },
      { header: 'Система', key: 'system_name', width: 25 },
      { header: 'Размер', key: 'size', width: 10 },
      { header: 'Позиционер', key: 'has_hex', width: 12 },
      { header: 'Количество', key: 'count', width: 10 }
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4CAF50' }
    };

    worksheet.addRows(data);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=titan_export.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Ошибка при создании Excel:', err);
    res.status(500).send('Ошибка при создании Excel: ' + err.message);
  }
});

// Печать (поддерживает фильтр по номеру наряда)
app.get('/titan/print', async (req, res) => {
  try {
    const { order_number } = req.query;
    let sql = 'SELECT * FROM titan_orders';
    const params = [];
    if (order_number) {
      sql += ' WHERE order_number = $1';
      params.push(order_number);
    }
    sql += ' ORDER BY order_date, order_number';
    const result = await pool.query(sql, params);
    const orders = result.rows;
    orders.forEach(o => {
      if (o.order_date && typeof o.order_date === 'object') {
        o.order_date = o.order_date.toISOString().slice(0, 10);
      }
    });
    res.render('titan_print', { orders, title: 'Печать нарядов', order_number: order_number || null });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка при загрузке данных для печати');
  }
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
  console.log(`Для доступа с других компьютеров используйте IP-адрес этого компьютера`);
});