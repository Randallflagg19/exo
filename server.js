require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

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
// База данных теперь не локальная, а на PostgreSQL, поэтому папка database не нужна, но оставим для совместимости?
// Можем не создавать, просто удалим.
const dbDir = path.join(appRoot, 'database'); // можно удалить, но оставим для обратной совместимости

// Создаём папку uploads, если её нет
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
  max: 20, // максимальное количество клиентов в пуле
  idleTimeoutMillis: 30000,
});

// Проверка подключения
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
    // Таблица files
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

    // Таблица users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      )
    `);
    console.log('Таблица users проверена/создана');

    // Добавление новых колонок, если их нет (PostgreSQL не имеет прямого "PRAGMA table_info", используем information_schema)
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

    // Заполняем users начальными данными, если таблица пуста
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

// ------ Multer для загрузки файлов (с уникальными именами) ------
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

// Обработка выбора пользователя
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

// Выход
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Главная страница
app.get('/', async (req, res) => {
  const { date, uploader, downloaded } = req.query;

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

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY upload_date DESC';

  try {
    const filesResult = await pool.query(sql, params);
    const files = filesResult.rows;

    // Группировка по месяцу и дню для сворачивания
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
      filters: { date, uploader, downloaded }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка базы данных');
  }
});

// Загрузка нескольких файлов (и одного изображения, опционально)
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

// Скачивание 3D-файла (с сохранением списка всех скачавших)
app.get('/download/:id', async (req, res) => {
  const fileId = req.params.id;
  const downloader = req.session.user;

  try {
    const fileResult = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    if (fileResult.rows.length === 0) {
      return res.status(404).send('Файл не найден.');
    }
    const file = fileResult.rows[0];

    // Функция для обновления списка скачавших
    const updateDownloaders = (currentList, newUser) => {
      if (!currentList) return newUser;
      const users = currentList.split(',').map(u => u.trim());
      if (users.includes(newUser)) return currentList;
      return currentList + ', ' + newUser;
    };

    if (!file.downloaded) {
      // Первое скачивание
      const downloadDate = new Date().toISOString();
      await pool.query(
        'UPDATE files SET downloaded = TRUE, downloaded_by = $1, downloaded_date = $2 WHERE id = $3',
        [downloader, downloadDate, fileId]
      );
    } else {
      // Последующие скачивания
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

// Просмотр изображения в браузере (inline)
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

// Переключение статуса milled
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

// Переключение статуса baked
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

// Обновление комментария
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

// Проверка пароля и добавление пользователя
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
    if (err.code === '23505') { // уникальность violation
      return res.render('add-user', { error: 'Пользователь с таким именем уже существует' });
    }
    console.error(err);
    res.render('add-user', { error: 'Ошибка базы данных' });
  }
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
  console.log(`Для доступа с других компьютеров используйте IP-адрес этого компьютера`);
});
