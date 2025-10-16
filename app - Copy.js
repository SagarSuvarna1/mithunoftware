// temple-billing/app.js

const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');

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
    if (err) {
      console.error("Login DB error:", err);
      return res.render('login', { error: 'Login failed. Try again.' });
    }

    if (row) {
      req.session.user = row;
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

  const today = new Date().toISOString().split('T')[0];
  const username = req.session.user.username;

 // ✅ NEW: Sum qty for each pooja
db.all(
  'SELECT pooja_name, SUM(qty) as count FROM billing WHERE bill_date = ? GROUP BY pooja_name ORDER BY count DESC',
  [today],
  (err, poojas) => {
      if (err) {
        console.error("Top Poojas Query Error:", err);
        return res.send("Dashboard load error.");
      }

      db.get('SELECT SUM(total) as total FROM billing WHERE bill_date = ?', [today], (err, todayResult) => {
        db.get('SELECT SUM(total) as total FROM billing WHERE bill_date = ? AND username = ?', [today, username], (err, userResult) => {
          res.render('dashboard', {
            today_total: todayResult?.total || 0,
            user_total: userResult?.total || 0,
            top_poojas: poojas || []
          });
        });
      });
    }
  );
});

app.get('/billing', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  db.all('SELECT * FROM pooja_master', [], (err, poojas) => {
    if (err) {
      console.error("Load Pooja Master Error:", err);
      return res.send("Error loading billing page.");
    }
    res.render('billing', { poojas });
  });
});

app.post('/billing', (req, res) => {
  const { dev_name, pooja_name, qty, payment_mode = "Cash" } = req.body;
  const username = req.session.user.username;
  const bill_date = new Date().toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true
});


  db.get('SELECT price FROM pooja_master WHERE pooja_name = ?', [pooja_name], (err, row) => {
    if (err || !row) return res.send("Invalid pooja selected.");

    const price = row.price;
    const total = price * qty;

    db.run(
      'INSERT INTO billing (dev_name, pooja_name, qty, price, total, bill_date, username, payment_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [dev_name, pooja_name, qty, price, total, bill_date, username, payment_mode],
      function (err) {
        if (err) {
          console.error("Billing Insert Error:", err);
          return res.send("Billing failed.");
        }

        const bill_id = this.lastID;

        res.render('receipt', {
          dev_name,
          pooja_name,
          qty,
          price,
          total,
          bill_id,
          bill_date,
          payment_mode  // ✅ THIS LINE FIXES YOUR ERROR
        });
      }
    );
  });
});

app.get('/pooja-master', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  db.all('SELECT * FROM pooja_master', [], (err, poojas) => {
    if (err) {
      console.error("Pooja Master Load Error:", err);
      return res.send("Error loading pooja master.");
    }
    res.render('pooja', { poojas });
  });
});

app.post('/pooja-master/add', (req, res) => {
  const { pooja_name, price } = req.body;
  db.run('INSERT INTO pooja_master (pooja_name, price) VALUES (?, ?)', [pooja_name, price], (err) => {
    if (err) {
      console.error("Add Pooja Error:", err);
      return res.send("Failed to add pooja.");
    }
    res.redirect('/pooja-master');
  });
});

app.post('/pooja-master/update/:id', (req, res) => {
  const { price } = req.body;
  db.run('UPDATE pooja_master SET price = ? WHERE id = ?', [price, req.params.id], (err) => {
    if (err) {
      console.error("Update Pooja Error:", err);
      return res.send("Failed to update pooja.");
    }
    res.redirect('/pooja-master');
  });
});

app.post('/pooja-master/delete/:id', (req, res) => {
  db.run('DELETE FROM pooja_master WHERE id = ?', [req.params.id], (err) => {
    if (err) {
      console.error("Delete Pooja Error:", err);
      return res.send("Failed to delete pooja.");
    }
    res.redirect('/pooja-master');
  });
});
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

  if (pooja_name) {
    sql += ` AND pooja_name = ?`;
    params.push(pooja_name);
  }

  if (username) {
    sql += ` AND username = ?`;
    params.push(username);
  }

  db.all('SELECT DISTINCT pooja_name FROM billing', [], (err1, poojas) => {
    db.all('SELECT DISTINCT username FROM billing', [], (err2, users) => {
      db.all(sql, params, (err3, rows) => {
        res.render('report', { poojas, users, results: rows });
      });
    });
  });
});
const ExcelJS = require('exceljs');

app.get('/report/export', (req, res) => {
  const sql = `SELECT * FROM billing ORDER BY bill_date DESC`;

  db.all(sql, [], async (err, rows) => {
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



// New helper to get last withdrawal summary
function getLastWithdraw(user, callback) {
  const sql = `
    SELECT MAX(rowid) as last_id FROM billing
    WHERE username = ? AND withdrawn = 1
  `;

  db.get(sql, [user.username], (err, row) => {
    if (err || !row || !row.last_id) return callback(null);

    db.all(
      `SELECT * FROM billing WHERE username = ? AND rowid <= ? AND withdrawn = 1 ORDER BY rowid DESC`,
      [user.username, row.last_id],
      (err2, rows) => {
        if (err2 || rows.length === 0) return callback(null);

        let cash = 0, online = 0, total = 0;
        rows.forEach(r => {
          if (r.payment_mode === 'Online') online += r.total;
          else cash += r.total;
          total += r.total;
        });

        callback({
          date: rows[0].bill_date,
          cash, online, total
        });
      }
    );
  });
}
// Helper function to get last withdrawn time
function getLastWithdraw(user, callback) {
  const sql = `
    SELECT MAX(rowid) as id, MAX(bill_date) as date
    FROM billing
    WHERE username = ? AND withdrawn = 1
  `;
  db.get(sql, [user.username], (err, row) => {
    if (err || !row || !row.date) return callback(null);
    callback(row);
  });
}

app.get('/collection', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  // Match DB date format: DD/MM/YYYY
  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

  const sql = `
    SELECT * FROM billing
    WHERE username = ? 
      AND bill_date LIKE ?
      AND (withdrawn IS NULL OR withdrawn = 0)
    ORDER BY rowid DESC
  `;

  db.all(sql, [user.username, `${today}%`], (err, rows) => {
    if (err) {
      console.error("Collection Fetch Error:", err);
      return res.send('DB Error');
    }

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
        today,
        loginTime: req.session.loginTime || new Date(),
        lastWithdraw: last,
        print: req.query.print === 'yes'
      });
    });
  });
});

app.post('/collection/withdraw', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

  const sql = `
    UPDATE billing 
    SET withdrawn = 1 
    WHERE username = ? AND bill_date LIKE ? AND (withdrawn IS NULL OR withdrawn = 0)
  `;

  db.run(sql, [user.username, `${today}%`], function (err) {
    if (err) {
      console.error("Withdraw Error:", err);
      return res.send("Withdraw Error");
    }

    res.redirect('/collection?print=yes');
  });
});



app.listen(3000, () => {
  console.log('✅ Temple Billing running on http://localhost:3000');
});
