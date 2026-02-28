const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// ------ Определяем корневую папку приложения ------
const appRoot = process.env.PKG 
  ? path.dirname(process.execPath) 
  : path.resolve(__dirname);

console.log('Корневая папка приложения:', appRoot);

// ------ Пароль для добавления новых пользователей ------
const ADD_USER_PASSWORD = '545';

// Пути к папкам для данных
const uploadDir = path.join(appRoot, 'uploads');
const dbDir = path.join(appRoot, 'database');
const dbPath = path.join(dbDir, 'files.db');

// Создаём папки, если их нет
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log('Создана папка для загрузок:', uploadDir);
}
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log('Создана папка для базы данных:', dbDir);
}

// ------ Подключение к базе данных SQLite ------
const db = new sqlite3.Database(dbPath);

// Инициализация таблиц
db.serialize(() => {
  // Таблица файлов (с поддержкой изображений, статусов и комментария)
  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      image_name TEXT,
      uploader TEXT NOT NULL,
      upload_date TEXT NOT NULL,
      downloaded BOOLEAN DEFAULT 0,
      downloaded_by TEXT,
      downloaded_date TEXT,
      milled BOOLEAN DEFAULT 0,
      baked BOOLEAN DEFAULT 0,
      comment TEXT
    )
  `);

  // Таблица пользователей
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    )
  `);

  // Добавляем новые колонки, если их нет (для старых баз)
  const checkAndAddColumn = (columnName, columnDef) => {
    db.all("PRAGMA table_info(files)", (err, rows) => {
      if (err) {
        console.error('Ошибка при проверке структуры таблицы files:', err);
        return;
      }
      const hasColumn = rows.some(row => row.name === columnName);
      if (!hasColumn) {
        db.run(`ALTER TABLE files ADD COLUMN ${columnName} ${columnDef}`, (alterErr) => {
          if (alterErr) {
            console.error(`Не удалось добавить колонку ${columnName}:`, alterErr);
          } else {
            console.log(`Колонка ${columnName} успешно добавлена`);
          }
        });
      }
    });
  };

  checkAndAddColumn('image_name', 'TEXT');
  checkAndAddColumn('milled', 'BOOLEAN DEFAULT 0');
  checkAndAddColumn('baked', 'BOOLEAN DEFAULT 0');
  checkAndAddColumn('comment', 'TEXT');

  // Если таблица пользователей пуста, заполняем начальными именами (новый список)
  db.get("SELECT COUNT(*) AS count FROM users", (err, row) => {
    if (err) {
      console.error('Ошибка при проверке users:', err);
      return;
    }
    if (row.count === 0) {
      const defaultUsers = [
        'София', 'Анна', 'Маргарита', 'Слава', 'Егор',
        'Наталья', 'Мария', 'Сухроб', 'Абу', 'Альберт', 'Юлия'
      ];
      const stmt = db.prepare("INSERT INTO users (name) VALUES (?)");
      defaultUsers.forEach(name => {
        stmt.run(name, err => {
          if (err) console.error('Ошибка вставки пользователя:', err);
        });
      });
      stmt.finalize();
      console.log('Добавлены начальные пользователи');
    }
  });
});

// ------ Настройка Express ------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  // Не ставим text/html для маршрутов, отдающих файлы — иначе картинки открываются как текст
  const isFileRoute = req.path.startsWith('/image/') || req.path.startsWith('/download');
  if (!isFileRoute) {
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  }
  next();
});
app.use(session({
  secret: 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(appRoot, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(appRoot, 'views'));

// ------ Multer для загрузки файлов (с сохранением в подпапку пользователя) ------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(uploadDir, req.session.user);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    // Декодируем имя из latin1 в utf8 (как было)
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    // Защита от path traversal — берём только имя файла
    const safeName = path.basename(decodedName);
    cb(null, safeName);
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
app.get('/login', (req, res) => {
  db.all("SELECT name FROM users ORDER BY name", (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Ошибка БД');
    }
    const users = rows.map(row => row.name);
    res.render('login', { users: users });
  });
});

// Обработка выбора пользователя
app.post('/set-user', (req, res) => {
  const username = req.body.username;
  db.get("SELECT name FROM users WHERE name = ?", [username], (err, row) => {
    if (err || !row) {
      return res.redirect('/login');
    }
    req.session.user = username;
    res.redirect('/');
  });
});

// Выход
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Главная страница
app.get('/', (req, res) => {
  const { date, uploader, downloaded } = req.query;

  let sql = 'SELECT * FROM files';
  const params = [];
  const conditions = [];

  if (date) {
    conditions.push('date(upload_date) = ?');
    params.push(date);
  }
  if (uploader) {
    conditions.push('uploader = ?');
    params.push(uploader);
  }
  if (downloaded !== undefined && downloaded !== '') {
    conditions.push('downloaded = ?');
    params.push(downloaded === 'true' ? 1 : 0);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY upload_date DESC';

  db.all(sql, params, (err, files) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Ошибка базы данных');
    }

    // Группировка по месяцу и дню для сворачивания (новые сверху)
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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

    db.all('SELECT DISTINCT uploader FROM files', (err, rows) => {
      const uploaders = rows.map(row => row.uploader);
      res.render('index', {
        files: files,
        groupedFiles,
        todayKey: today,
        users: uploaders,
        currentUser: req.session.user,
        filters: { date, uploader, downloaded }
      });
    });
  });
});

// Загрузка файла (с новыми полями)
app.post('/upload', upload.fields([
  { name: 'stlFile', maxCount: 1 },
  { name: 'imageFile', maxCount: 1 }
]), (req, res) => {
  if (!req.files || !req.files['stlFile']) {
    return res.status(400).send('3D-файл не выбран.');
  }

  const stlFile = req.files['stlFile'][0];
  const imageFile = req.files['imageFile'] ? req.files['imageFile'][0] : null;

  // Декодируем оригинальное имя STL (для БД)
  const decodedStlName = Buffer.from(stlFile.originalname, 'latin1').toString('utf8');
  const storedStlName = stlFile.filename; // уже безопасное имя
  let imageName = null;

  if (imageFile) {
    // Для изображения тоже декодируем имя, но сохраняем как есть
    imageName = imageFile.filename;
  }

  const uploader = req.session.user;
  const uploadDate = new Date().toISOString();

  // Новые поля
  const milled = req.body.milled === 'on' ? 1 : 0;
  const baked = req.body.baked === 'on' ? 1 : 0;
  const comment = req.body.comment || '';

  db.run(
    `INSERT INTO files 
     (original_name, stored_name, image_name, uploader, upload_date, downloaded, milled, baked, comment) 
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [decodedStlName, storedStlName, imageName, uploader, uploadDate, milled, baked, comment],
    function(err) {
      if (err) {
        console.error(err);
        return res.status(500).send('Ошибка при сохранении в БД.');
      }
      res.redirect('/');
    }
  );
});

// Скачивание 3D-файла (всегда доступно)
app.get('/download/:id', (req, res) => {
  const fileId = req.params.id;
  const downloader = req.session.user;

  db.get('SELECT * FROM files WHERE id = ?', [fileId], (err, file) => {
    if (err || !file) {
      return res.status(404).send('Файл не найден.');
    }

    // Если файл ещё не был скачан, помечаем это
    if (!file.downloaded) {
      const downloadDate = new Date().toISOString();
      db.run(
        'UPDATE files SET downloaded = 1, downloaded_by = ?, downloaded_date = ? WHERE id = ?',
        [downloader, downloadDate, fileId],
        (updateErr) => {
          if (updateErr) console.error(updateErr);
        }
      );
    }

    const filePath = path.join(uploadDir, file.uploader, file.stored_name);
    res.download(filePath, file.original_name);
  });
});

// MIME-типы для изображений (чтобы браузер открывал картинку, а не показывал бинарник)
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
app.get('/image/:id', (req, res) => {
  const fileId = req.params.id;

  db.get('SELECT image_name, uploader FROM files WHERE id = ?', [fileId], (err, file) => {
    if (err || !file || !file.image_name) {
      return res.status(404).send('Изображение не найдено.');
    }

    const imagePath = path.join(uploadDir, file.uploader, file.image_name);
    const ext = path.extname(file.image_name).toLowerCase();
    const contentType = imageMime[ext] || 'image/png';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(imagePath);
  });
});

// Скачивание изображения (attachment)
app.get('/download-image/:id', (req, res) => {
  const fileId = req.params.id;

  db.get('SELECT image_name, uploader, original_name FROM files WHERE id = ?', [fileId], (err, file) => {
    if (err || !file || !file.image_name) {
      return res.status(404).send('Изображение не найдено.');
    }

    const imagePath = path.join(uploadDir, file.uploader, file.image_name);
    res.download(imagePath, file.original_name); // или другое имя
  });
});

// Удаление файла (с кодом 78)
app.post('/delete/:id', (req, res) => {
  const fileId = req.params.id;
  const { code } = req.body;

  if (code !== '78') {
    return res.status(403).send('Неверный код');
  }

  db.get('SELECT * FROM files WHERE id = ?', [fileId], (err, file) => {
    if (err || !file) {
      return res.status(404).send('Файл не найден');
    }

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

    db.run('DELETE FROM files WHERE id = ?', fileId, function(err) {
      if (err) {
        console.error(err);
        return res.status(500).send('Ошибка при удалении из БД');
      }
      res.redirect('/');
    });
  });
});

// ------ Управление статусами и комментариями (AJAX) ------

// Переключение статуса milled
app.post('/toggle-milled/:id', (req, res) => {
  if (!req.session.user) return res.status(401).send('Не авторизован');
  db.run('UPDATE files SET milled = NOT milled WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).send('Ошибка БД');
    res.json({ success: true });
  });
});

// Переключение статуса baked
app.post('/toggle-baked/:id', (req, res) => {
  if (!req.session.user) return res.status(401).send('Не авторизован');
  db.run('UPDATE files SET baked = NOT baked WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).send('Ошибка БД');
    res.json({ success: true });
  });
});

// Обновление комментария
app.post('/comment/:id', (req, res) => {
  if (!req.session.user) return res.status(401).send('Не авторизован');
  const { comment } = req.body;
  db.run('UPDATE files SET comment = ? WHERE id = ?', [comment, req.params.id], function(err) {
    if (err) return res.status(500).send('Ошибка БД');
    res.json({ success: true });
  });
});

// ------ Управление пользователями ------

// Страница добавления пользователя (только для авторизованных)
app.get('/add-user', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('add-user', { error: null });
});

// Проверка пароля и добавление пользователя
app.post('/add-user', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { password, newUsername } = req.body;
  if (password !== ADD_USER_PASSWORD) {
    return res.render('add-user', { error: 'Неверный пароль' });
  }

  if (!newUsername || newUsername.trim() === '') {
    return res.render('add-user', { error: 'Имя не может быть пустым' });
  }

  db.run('INSERT INTO users (name) VALUES (?)', [newUsername.trim()], function(err) {
    if (err) {
      if (err.code === 'SQLITE_CONSTRAINT') {
        return res.render('add-user', { error: 'Пользователь с таким именем уже существует' });
      }
      console.error(err);
      return res.render('add-user', { error: 'Ошибка базы данных' });
    }
    res.redirect('/');
  });
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
  console.log(`Для доступа с других компьютеров используйте IP-адрес этого компьютера`);
});
