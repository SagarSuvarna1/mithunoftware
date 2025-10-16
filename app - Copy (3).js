const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const ExcelJS = require('exceljs');
const moment = require('moment');

const app = express();
const db = new sqlite3.Database('./db/temple.db');

// Fiscal Year Formatter
function getFiscalYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const startYear = month >= 3 ? year % 100 : (year - 1) % 100;
  const endYear = (startYear + 1) % 100;
  return `${startYear.toString().padStart(2, '0')}-${endYear.toString().padStart(2, '0')}`;
}

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
    if (err) return res.render('login', { error: 'Login failed.' });
    if (row) {
      req.session.user = row;
      req.session.loginTime = new Date();
      res.redirect('/dashboard');
    } else {
      res.render('login', { error: 'Invalid login.' });
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

  db.all(`SELECT pooja_name, SUM(qty) as count 
          FROM billing 
          WHERE bill_date LIKE ? 
          GROUP BY pooja_name 
          ORDER BY count DESC`, [`${today}%`], (err, topPoojas) => {

    db.get(`SELECT SUM(total) as total 
            FROM billing 
            WHERE bill_date LIKE ?`, [`${today}%`], (err2, todayResult) => {

      db.get(`SELECT SUM(total) as total 
              FROM billing 
              WHERE bill_date LIKE ? AND username = ?`, [`${today}%`, username], (err3, userResult) => {

        res.render('dashboard', {
          today_total: todayResult?.total || 0,
          user_total: userResult?.total || 0,
          top_poojas: topPoojas || []
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
  const { dev_name, pooja_name, qty, payment_mode = 'Cash' } = req.body;
  const username = req.session.user.username;
  const bill_date = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const fiscalYear = getFiscalYear();

  const qtyNum = parseInt(qty);
  if (isNaN(qtyNum) || qtyNum <= 0) return res.send("Invalid quantity");

  db.get('SELECT price FROM pooja_master WHERE pooja_name = ?', [pooja_name], (err, row) => {
    if (err || !row) return res.send("Invalid pooja selected.");
    const price = row.price;
    const total = price * qtyNum;

    db.get('SELECT receipt_no FROM billing WHERE receipt_no LIKE ? ORDER BY id DESC LIMIT 1', [`SRI/${fiscalYear}/%`], (err2, lastRow) => {
      let nextSerial = 1;
      if (lastRow) {
        const parts = lastRow.receipt_no.split('/');
        const lastSerial = parseInt(parts[2]);
        nextSerial = isNaN(lastSerial) ? 1 : lastSerial + 1;
      }

      const receipt_no = `SRI/${fiscalYear}/${nextSerial}`;

db.run(`INSERT INTO billing 
  (dev_name, pooja_name, qty, price, total, bill_date, username, payment_mode, withdrawn, receipt_no) 
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [dev_name, pooja_name, qtyNum, price, total, bill_date, username, payment_mode, 0, receipt_no],

        function (err3) {
        if (err3) return res.send("Billing failed: " + err3.message);

          res.render('receipt', {
            dev_name, pooja_name, qty: qtyNum, price, total,
            bill_id: this.lastID,
            bill_date, payment_mode,
            receipt_no
          });
        }
      );
    });
  });
});

// Pooja Master
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
// ✅ Helper: Get Last Withdrawal Summary


function getLastWithdraw(user, callback) {
  // Step 1: Get the last withdrawal record
  db.get(
    `SELECT * FROM withdrawals WHERE username = ? ORDER BY rowid DESC LIMIT 1`,
    [user.username],
    (err, last) => {
      if (err || !last) return callback(null);

      const formattedDate = last.datetime;
      const withdrawnAmount = parseFloat(last.amount || 0);

      // Step 2: Try to find withdraw_id from billing table
      db.get(
        `SELECT withdraw_id FROM billing WHERE username = ? AND withdraw_id IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
        [user.username],
        (err2, billRow) => {
          if (err2 || !billRow) {
            // Treat as partial withdrawal
            return callback({
              date: formattedDate,
              cash: withdrawnAmount,
              online: 0,
              total: withdrawnAmount
            });
          }

          const lastWithdrawId = billRow.withdraw_id;

          // Step 3: Get all billing entries with this withdraw_id (cash & online)
          db.all(
            `SELECT * FROM billing WHERE username = ? AND withdraw_id = ?`,
            [user.username, lastWithdrawId],
            (err3, bills) => {
              if (err3 || !bills || bills.length === 0) {
                // Possibly partial
                return callback({
                  date: formattedDate,
                  cash: withdrawnAmount,
                  online: 0,
                  total: withdrawnAmount
                });
              }

              let cash = 0, online = 0;
              bills.forEach(b => {
                const amt = parseFloat(b.total || 0);
                const isOnline = (b.payment_mode || '').toLowerCase().includes("online");
                if (isOnline) online += amt;
                else cash += amt;
              });

              const billingTotal = cash + online;

              // If billing total matches withdrawal — treat as full
              if (billingTotal === withdrawnAmount) {
                return callback({
                  date: formattedDate,
                  cash,
                  online,
                  total: billingTotal
                });
              } else {
                // Mismatch — probably partial, show only amount
                return callback({
                  date: formattedDate,
                  cash: withdrawnAmount,
                  online: 0,
                  total: withdrawnAmount
                });
              }
            }
          );
        }
      );
    }
  );
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

      let rawCash = 0, rawOnline = 0;
      rows.forEach(r => {
        const amt = r.total;
        const isOnline = (r.payment_mode || '').toLowerCase().includes('online');
        const isCleared = r.online_cleared === 1;

        if (isOnline && !isCleared) {
          rawOnline += amt;
        } else if (!isOnline) {
          rawCash += amt;
        }
      });

      db.all(
        `SELECT * FROM withdrawals WHERE username = ? AND datetime LIKE ?`,
        [user.username, pattern],
        (err2, withdrawals) => {
          let totalWithdrawn = 0;
          if (!err2 && withdrawals && withdrawals.length > 0) {
            withdrawals.forEach(w => totalWithdrawn += parseFloat(w.amount || 0));
          }

          let adjustedCash = rawCash;
          let adjustedOnline = rawOnline;
          let remainingWithdraw = totalWithdrawn;

          if (adjustedCash >= remainingWithdraw) {
            adjustedCash -= remainingWithdraw;
          } else {
            remainingWithdraw -= adjustedCash;
            adjustedCash = 0;
            adjustedOnline = Math.max(0, adjustedOnline - remainingWithdraw);
          }

          // ✅ Fetch Last Withdrawal Info
          getLastWithdraw(user, (lastWithdraw) => {
            res.render('collection', {
              bills: rows,
              summary: {
                cash: adjustedCash,
                online: adjustedOnline,
                total: adjustedCash + adjustedOnline,
                withdrawn: totalWithdrawn
              },
              user,
              today: todayDate,
              loginTime: req.session.loginTime || new Date(),
              print: req.query.print === 'yes',
              lastWithdraw: lastWithdraw || null
            });
          });
        }
      );
    }
  );
});


app.get('/collection/date', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  const rawDate = req.query.date;
  if (!rawDate) return res.send("Invalid date.");

  const [yyyy, mm, dd] = rawDate.split("-");
  const day = parseInt(dd).toString();
  const month = parseInt(mm).toString();
  const selectedDate = `${day}/${month}/${yyyy}`;
  const pattern = `${selectedDate}%`;

  db.all(
    `SELECT * FROM billing 
     WHERE username = ? AND bill_date LIKE ? 
     ORDER BY rowid DESC`,
    [user.username, pattern],
    (err, bills) => {
      if (err) return res.send("DB Error in billing");

      let cashCollected = 0, onlineCollected = 0, totalCollected = 0;

      bills.forEach(r => {
        const amt = parseFloat(r.total || 0);
        const isOnline = (r.payment_mode || '').toLowerCase().includes('online');

        if (isOnline) {
          onlineCollected += amt;
        } else {
          cashCollected += amt;
        }

        totalCollected += amt;
      });

      db.all(
        `SELECT * FROM withdrawals 
         WHERE username = ? AND datetime LIKE ?`,
        [user.username, pattern],
        (err2, withdrawals) => {
          if (err2) return res.send("DB Error in withdrawals");

          let withdrawnFromCash = 0;
          let withdrawnFromOnline = 0;

          withdrawals.forEach(w => {
            const amount = parseFloat(w.amount || 0);

            const remainingCash = cashCollected - withdrawnFromCash;
            if (remainingCash >= amount) {
              withdrawnFromCash += amount;
            } else {
              if (remainingCash > 0) {
                withdrawnFromCash += remainingCash;
                withdrawnFromOnline += amount - remainingCash;
              } else {
                withdrawnFromOnline += amount;
              }
            }
          });

          const remainingCashInHand = Math.max(0, cashCollected - withdrawnFromCash);

          res.render('collection-by-date', {
            bills,
            withdrawals,
            summary: {
              cash: cashCollected,
              online: onlineCollected,
              total: totalCollected,
              withdrawn: withdrawnFromCash + withdrawnFromOnline,
              remaining: remainingCashInHand
            },
            user,
            selectedDate
          });
        }
      );
    }
  );
});


app.post('/collection/withdraw', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  const type = req.body.withdraw_type; // 'full' or 'partial'
  const customAmount = parseFloat(req.body.partial_amount || 0);
  const todayDate = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  const pattern = `${todayDate}%`;

  db.all(`
    SELECT * FROM billing 
    WHERE username = ? AND bill_date LIKE ? 
    AND (withdrawn IS NULL OR withdrawn = 0) 
    AND (payment_mode IS NULL OR LOWER(payment_mode) NOT LIKE '%online%')`,
    [user.username, pattern],
    (err, bills) => {
      if (err) return res.send("Error fetching bills");

      let totalCash = 0;
      bills.forEach(b => totalCash += parseFloat(b.total || 0));

      // Get today's total withdrawn amount from withdrawal table
      db.all(`SELECT * FROM withdrawals WHERE username = ? AND datetime LIKE ?`, [user.username, pattern], (err2, rows) => {
        let alreadyWithdrawn = 0;
        if (!err2 && rows.length > 0) {
          rows.forEach(w => alreadyWithdrawn += parseFloat(w.amount || 0));
        }

        const cashLeft = totalCash - alreadyWithdrawn;

        if (type === 'partial') {
          if (!customAmount || customAmount <= 0 || customAmount > cashLeft) {
            return res.send("❌ Invalid partial amount. You only have ₹" + cashLeft.toFixed(2) + " available.");
          }
        }

        const withdrawAmount = type === 'partial' ? customAmount : cashLeft;

        // Do not withdraw zero or negative
        if (withdrawAmount <= 0) {
          return res.send("❌ No cash left to withdraw.");
        }

        const datetime = require('moment')().format('D/M/YYYY, h:mm:ss a');

        db.get(`SELECT MAX(withdraw_id) as last_id FROM billing WHERE withdraw_id IS NOT NULL`, [], (err3, row) => {
          const nextWithdrawId = (row?.last_id || 0) + 1;

          // Insert withdrawal log
          db.run(`INSERT INTO withdrawals (username, amount, datetime) VALUES (?, ?, ?)`,
            [user.username, withdrawAmount, datetime], (err4) => {
              if (err4) return res.send("❌ Failed to insert withdrawal");

              // Always clear online
              db.run(`UPDATE billing SET online_cleared = 1 
                      WHERE username = ? AND bill_date LIKE ? 
                      AND LOWER(payment_mode) LIKE '%online%'`,
                [user.username, pattern],
                (err5) => {
                  if (err5) return res.send("❌ Failed to clear online payments");

                  if (type === 'full') {
                    // Mark remaining cash entries as withdrawn
                    db.run(`UPDATE billing SET withdrawn = 1, withdraw_id = ? 
                            WHERE username = ? AND bill_date LIKE ? 
                            AND (withdrawn IS NULL OR withdrawn = 0) 
                            AND (payment_mode IS NULL OR LOWER(payment_mode) NOT LIKE '%online%')`,
                      [nextWithdrawId, user.username, pattern],
                      (err6) => {
                        if (err6) return res.send("❌ Error updating billing");
                        res.redirect('/collection?print=yes');
                      });
                  } else {
                    // For partial, do not mark billing withdrawn
                    res.redirect('/collection?print=yes');
                  }
                });
            });
        });
      });
    });
});


// GET report page
app.get('/report', (req, res) => {
  db.all('SELECT DISTINCT pooja_name FROM billing', [], (err, poojas) => {
    db.all('SELECT DISTINCT username FROM billing', [], (err2, users) => {
      res.render('report', { poojas, users, results: null });
    });
  });
});



app.post('/report', (req, res) => {
  const { from, to, pooja_name, username, payment_mode } = req.body;

  const formattedFrom = moment(from, 'D/M/YYYY').format('D/M/YYYY');
  const formattedTo = moment(to, 'D/M/YYYY').format('D/M/YYYY');

  let sql = `SELECT * FROM billing WHERE substr(bill_date, 1, instr(bill_date, ',') - 1) BETWEEN ? AND ?`;
  let params = [formattedFrom, formattedTo];

  if (pooja_name) {
    sql += ` AND pooja_name = ?`;
    params.push(pooja_name);
  }

  if (username) {
    sql += ` AND username = ?`;
    params.push(username);
  }

  if (payment_mode) {
    sql += ` AND LOWER(payment_mode) = ?`;
    params.push(payment_mode.toLowerCase());
  }

  db.all('SELECT DISTINCT pooja_name FROM billing', [], (err1, poojas) => {
    db.all('SELECT DISTINCT username FROM billing', [], (err2, users) => {
      db.all('SELECT DISTINCT payment_mode FROM billing', [], (err3, paymentModes) => {
        db.all(sql, params, (err4, rows) => {
          res.render('report', {
            poojas,
            users,
            paymentModes,
            results: rows
          });
        });
      });
    });
  });
});

app.get('/report/export', async (req, res) => {
  const { from, to, pooja_name, username, payment_mode } = req.query;

  if (!from || !to) {
    return res.status(400).send('Missing "from" and "to" query parameters.');
  }

  const formattedFrom = moment(from, 'D/M/YYYY').format('D/M/YYYY');
  const formattedTo = moment(to, 'D/M/YYYY').format('D/M/YYYY');

  let sql = `SELECT * FROM billing WHERE substr(bill_date, 1, instr(bill_date, ',') - 1) BETWEEN ? AND ?`;
  let params = [formattedFrom, formattedTo];

  if (pooja_name) {
    sql += ` AND pooja_name = ?`;
    params.push(pooja_name);
  }

  if (username) {
    sql += ` AND username = ?`;
    params.push(username);
  }

  if (payment_mode) {
    sql += ` AND LOWER(payment_mode) = ?`;
    params.push(payment_mode.toLowerCase());
  }

  db.all(sql, params, async (err, rows) => {
    if (err) return res.status(500).send("Database error");

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Temple Report');

    worksheet.columns = [
      { header: 'Receipt No', key: 'receipt_no', width: 10 },
      { header: 'Date', key: 'bill_date', width: 15 },
      { header: 'Devotee', key: 'dev_name', width: 20 },
      { header: 'Pooja', key: 'pooja_name', width: 20 },
      { header: 'Qty', key: 'qty', width: 10 },
      { header: 'Total ₹', key: 'total', width: 12 },
      { header: 'Payment Mode', key: 'payment_mode', width: 15 },
      { header: 'User', key: 'username', width: 15 },
    ];

    rows.forEach(row => worksheet.addRow(row));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=temple-report.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  });
});


app.get('/withdraw', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/login');
  res.render('withdraw-form', { user });
});
app.post('/withdraw', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  const { amount } = req.body;
  const now = new Date().toLocaleString('en-IN'); // Use Indian format

  db.run(
    'INSERT INTO withdrawals (username, amount, datetime) VALUES (?, ?, ?)',
    [user.username, amount, now],
    (err) => {
      if (err) return res.send('Error saving withdrawal.');
      res.redirect('/collection/date?date=' + new Date().toISOString().slice(0, 10)); // reload today's report
    }
  );
});

app.listen(3000, () => {
  console.log('✅ Temple Billing running at http://localhost:3000');
});
