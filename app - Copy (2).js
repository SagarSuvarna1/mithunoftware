// temple-billing/app.js

const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const ExcelJS = require('exceljs');

const app = express();
const db = new sqlite3.Database('./db/temple.db');




// Middleware
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(session({
  secret: 'temple-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 15 * 60 * 1000 }
}));

// Routes
app.get('/', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
    if (err) return res.render('login', { error: 'Login failed. Try again.' });
    if (row) {
      req.session.user = row;
      req.session.loginTime = new Date();
      res.redirect('/dashboard');
    } else {
      res.render('login', { error: 'Invalid login!' });
    }
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  const username = req.session.user.username;

  db.all('SELECT pooja_name, SUM(qty) as count FROM billing WHERE bill_date LIKE ? GROUP BY pooja_name ORDER BY count DESC', [`${today}%`], (err, poojas) => {
    if (err) return res.send("Dashboard load error.");

    db.get('SELECT SUM(total) as total FROM billing WHERE bill_date LIKE ?', [`${today}%`], (err, todayResult) => {
      db.get('SELECT SUM(total) as total FROM billing WHERE bill_date LIKE ? AND username = ?', [`${today}%`, username], (err, userResult) => {
        res.render('dashboard', {
          today_total: todayResult?.total || 0,
          user_total: userResult?.total || 0,
          top_poojas: poojas || []
        });
      });
    });
  });
});

app.get('/billing', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  db.all('SELECT * FROM pooja_master', [], (err, poojas) => {
    if (err) return res.send("Error loading billing page.");
    res.render('billing', { poojas });
  });
});

app.post('/billing', (req, res) => {
  const { dev_name, pooja_name, qty, payment_mode = "Cash" } = req.body;
  const username = req.session.user.username;
  const bill_date = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  db.get('SELECT price FROM pooja_master WHERE pooja_name = ?', [pooja_name], (err, row) => {
    if (err || !row) return res.send("Invalid pooja selected.");
    const price = row.price;
    const total = price * qty;

    db.run(
      'INSERT INTO billing (dev_name, pooja_name, qty, price, total, bill_date, username, payment_mode, withdrawn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
      [dev_name, pooja_name, qty, price, total, bill_date, username, payment_mode],
      function (err) {
        if (err) return res.send("Billing failed.");
        res.render('receipt', { dev_name, pooja_name, qty, price, total, bill_id: this.lastID, bill_date, payment_mode });
      }
    );
  });
});

// Pooja Master routes (add/update/delete)
app.get('/pooja-master', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  db.all('SELECT * FROM pooja_master', [], (err, poojas) => {
    if (err) return res.send("Error loading pooja master.");
    res.render('pooja', { poojas });
  });
});

app.post('/pooja-master/add', (req, res) => {
  const { pooja_name, price } = req.body;
  db.run('INSERT INTO pooja_master (pooja_name, price) VALUES (?, ?)', [pooja_name, price], err => {
    if (err) return res.send("Failed to add pooja.");
    res.redirect('/pooja-master');
  });
});

app.post('/pooja-master/update/:id', (req, res) => {
  const { price } = req.body;
  db.run('UPDATE pooja_master SET price = ? WHERE id = ?', [price, req.params.id], err => {
    if (err) return res.send("Failed to update pooja.");
    res.redirect('/pooja-master');
  });
});

app.post('/pooja-master/delete/:id', (req, res) => {
  db.run('DELETE FROM pooja_master WHERE id = ?', [req.params.id], err => {
    if (err) return res.send("Failed to delete pooja.");
    res.redirect('/pooja-master');
  });
});

// Collection Page
function getLastWithdraw(user, callback) {
  const sql = `SELECT MAX(rowid) as id FROM billing WHERE username = ? AND withdrawn = 1`;
  db.get(sql, [user.username], (err, row) => {
    if (err || !row || !row.id) return callback(null);
    db.all('SELECT * FROM billing WHERE username = ? AND rowid <= ? AND withdrawn = 1', [user.username, row.id], (err2, rows) => {
      if (err2 || !rows.length) return callback(null);
      let cash = 0, online = 0, total = 0;
      rows.forEach(r => {
        if (r.payment_mode.toLowerCase().includes("online")) online += r.total;
        else cash += r.total;
        total += r.total;
      });
      callback({ date: rows[0].bill_date, cash, online, total });
    });
  });
}

let withdrawCounter = 1; // You can replace this with a DB call if needed.

function getLastWithdraw(user, callback) {
  const sql = `
    SELECT withdraw_id, MAX(rowid) as max_id 
    FROM billing 
    WHERE username = ? AND withdraw_id IS NOT NULL 
    GROUP BY withdraw_id 
    ORDER BY max_id DESC LIMIT 1
  `;
  db.get(sql, [user.username], (err, row) => {
    if (err || !row) return callback(null);

    db.all(
      `SELECT * FROM billing WHERE username = ? AND withdraw_id = ?`,
      [user.username, row.withdraw_id],
      (err2, bills) => {
        if (err2 || !bills || bills.length === 0) return callback(null);

        let cash = 0, online = 0, total = 0;
        bills.forEach(r => {
          if ((r.payment_mode || '').toLowerCase().includes('online')) online += r.total;
          else cash += r.total;
          total += r.total;
        });

        callback({
          date: bills[0].bill_date,
          cash,
          online,
          total
        });
      }
    );
  });
}

app.get('/collection', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  const todayDate = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  const pattern = `${todayDate}%`;

  db.all(
    `SELECT * FROM billing 
     WHERE username = ? 
     AND bill_date LIKE ? 
     AND (withdrawn IS NULL OR withdrawn = 0) 
     ORDER BY rowid DESC`,
    [user.username, pattern],
    (err, rows) => {
      if (err) return res.send('DB Error');

      let cash = 0, online = 0, total = 0;
      rows.forEach(r => {
        const amt = r.total;
        if ((r.payment_mode || '').toLowerCase().includes('online')) online += amt;
        else cash += amt;
        total += amt;
      });

      getLastWithdraw(user, (last) => {
        res.render('collection', {
          bills: rows,
          summary: { cash, online, total },
          user,
          today: todayDate,
          loginTime: req.session.loginTime || new Date(),
          lastWithdraw: last,
          print: req.query.print === 'yes'
        });
      });
    }
  );
});

app.post('/collection/withdraw', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  // Step 1: Find the last used withdraw_id and increment it
  db.get(
    `SELECT MAX(withdraw_id) as last_id FROM billing WHERE withdraw_id IS NOT NULL`,
    [],
    (err, row) => {
      const nextWithdrawId = (row?.last_id || 0) + 1;

      const todayDate = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
      const pattern = `${todayDate}%`;

      db.run(
        `UPDATE billing 
         SET withdrawn = 1, withdraw_id = ? 
         WHERE username = ? AND bill_date LIKE ? AND (withdrawn IS NULL OR withdrawn = 0)`,
        [nextWithdrawId, user.username, pattern],
        (err2) => {
          if (err2) return res.send("Withdraw Error");

          res.redirect('/collection?print=yes');
        }
      );
    }
  );
});

app.get('/collection/date', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  const rawDate = req.query.date; // "YYYY-MM-DD"
  if (!rawDate) return res.send("Invalid date.");

  const [yyyy, mm, dd] = rawDate.split("-");
  const selectedDate = `${dd}/${mm}/${yyyy}`; // e.g., "13/07/2025"
  const pattern = `${selectedDate}%`;

  db.all(
    `SELECT * FROM billing 
     WHERE username = ? 
     AND bill_date LIKE ? 
     ORDER BY rowid DESC`,
    [user.username, pattern],
    (err, rows) => {
      if (err) return res.send("DB Error");

      let cash = 0, online = 0, total = 0;
      rows.forEach(r => {
        const amt = r.total;
        if ((r.payment_mode || '').toLowerCase().includes('online')) online += amt;
        else cash += amt;
        total += amt;
      });

      res.render('collection-by-date', {
        bills: rows,
        summary: { cash, online, total },
        user,
        selectedDate
      });
    }
  );
});

// Report + Export
app.get('/report', (req, res) => {
  db.all('SELECT DISTINCT pooja_name FROM billing', [], (err, poojas) => {
    db.all('SELECT DISTINCT username FROM billing', [], (err2, users) => {
      res.render('report', { poojas, users, results: null });
    });
  });
});

app.post('/report', (req, res) => {
  const { from, to, pooja_name, username } = req.body;
  let sql = `SELECT * FROM billing WHERE bill_date BETWEEN ? AND ?`;
  let params = [from, to];
  if (pooja_name) { sql += ` AND pooja_name = ?`; params.push(pooja_name); }
  if (username) { sql += ` AND username = ?`; params.push(username); }
  db.all('SELECT DISTINCT pooja_name FROM billing', [], (err1, poojas) => {
    db.all('SELECT DISTINCT username FROM billing', [], (err2, users) => {
      db.all(sql, params, (err3, rows) => {
        res.render('report', { poojas, users, results: rows });
      });
    });
  });
});

app.get('/report/export', (req, res) => {
  db.all('SELECT * FROM billing ORDER BY bill_date DESC', [], async (err, rows) => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Temple Report');
    worksheet.columns = [
      { header: 'Bill ID', key: 'id', width: 10 },
      { header: 'Date', key: 'bill_date', width: 15 },
      { header: 'Devotee', key: 'dev_name', width: 20 },
      { header: 'Pooja', key: 'pooja_name', width: 20 },
      { header: 'Qty', key: 'qty', width: 10 },
      { header: 'Total ₹', key: 'total', width: 12 },
      { header: 'User', key: 'username', width: 15 },
    ];
    rows.forEach(row => worksheet.addRow(row));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=temple-report.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  });
});

app.listen(3000, () => {
  console.log('Temple Billing running on http://localhost:3000');
});
