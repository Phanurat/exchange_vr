require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const app = express();
const db = new sqlite3.Database('./crypto.db');

app.use(express.json());
app.use(express.static('public'));

// --- [DATABASE INIT] ตาม Data Dict เป๊ะๆ ---
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS wallets (
        wallet_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        wallet_type VARCHAR, 
        coin_symbol VARCHAR,
        balance DECIMAL(18, 8) DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_name TEXT UNIQUE,
        password TEXT,
        spot_wallet_id INTEGER,
        funding_wallet_id INTEGER,
        FOREIGN KEY(spot_wallet_id) REFERENCES wallets(wallet_id),
        FOREIGN KEY(funding_wallet_id) REFERENCES wallets(wallet_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS p2p_order (
        order_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        order_type VARCHAR, 
        coin_symbol VARCHAR,
        fiat_symbol VARCHAR,
        price DECIMAL(18, 2),
        amount DECIMAL(18, 8),
        status_orders VARCHAR DEFAULT 'open',
        FOREIGN KEY(user_id) REFERENCES users(user_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        tx_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER,
        receiver_id INTEGER,
        tx_type VARCHAR, 
        coin_symbol VARCHAR,
        amount DECIMAL(18, 8),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
});

// --- [AUTH API] ---
app.post('/api/register', (req, res) => {
    const { user_name, password } = req.body;
    db.run(`INSERT INTO users (user_name, password) VALUES (?, ?)`, [user_name, password], function(err) {
        if (err) return res.status(400).json({ success: false, message: "Username exists" });
        const uid = this.lastID;
        db.run(`INSERT INTO wallets (user_id, wallet_type, coin_symbol, balance) VALUES (?, 'Spot', 'BTC', 0)`, [uid], function() {
            const sid = this.lastID;
            db.run(`INSERT INTO wallets (user_id, wallet_type, coin_symbol, balance) VALUES (?, 'Funding', 'THB', 0)`, [uid], function() {
                const fid = this.lastID;
                db.run(`UPDATE users SET spot_wallet_id = ?, funding_wallet_id = ? WHERE user_id = ?`, [sid, fid, uid], () => {
                    res.json({ success: true });
                });
            });
        });
    });
});

app.post('/api/login', (req, res) => {
    const { user_name, password } = req.body;
    db.get(`SELECT * FROM users WHERE user_name = ? AND password = ?`, [user_name, password], (err, row) => {
        if (err || !row) return res.status(401).json({ success: false, message: "Login Failed" });
        res.json({ success: true, user_id: row.user_id, user_name: row.user_name });
    });
});

// --- [EXCHANGE LOGIC API] ---

// 1. Overview & Wallets
app.get('/api/account/:uid', (req, res) => {
    const sql = `SELECT u.user_name, sw.balance as spot_bal, sw.coin_symbol as spot_coin, fw.balance as fund_bal, fw.coin_symbol as fund_coin 
                 FROM users u JOIN wallets sw ON u.spot_wallet_id = sw.wallet_id JOIN wallets fw ON u.funding_wallet_id = fw.wallet_id WHERE u.user_id = ?`;
    db.get(sql, [req.params.uid], (err, row) => res.json(row));
});

// 2. Mint (Deposit to Funding)
app.post('/api/mint', (req, res) => {
    const { user_id, amount, coin_symbol } = req.body;
    db.get(`SELECT funding_wallet_id FROM users WHERE user_id = ?`, [user_id], (err, user) => {
        db.run(`UPDATE wallets SET balance = balance + ?, coin_symbol = ? WHERE wallet_id = ?`, [amount, coin_symbol, user.funding_wallet_id], () => {
            db.run(`INSERT INTO transactions (sender_id, receiver_id, tx_type, coin_symbol, amount) VALUES (0, ?, 'Deposit', ?, ?)`, [user_id, coin_symbol, amount]);
            res.json({ success: true });
        });
    });
});

// 3. Burn (Withdraw from Funding)
app.post('/api/burn', (req, res) => {
    const { user_id, amount } = req.body;
    db.get(`SELECT funding_wallet_id FROM users WHERE user_id = ?`, [user_id], (err, user) => {
        db.run(`UPDATE wallets SET balance = balance - ? WHERE wallet_id = ? AND balance >= ?`, [amount, user.funding_wallet_id, amount], function() {
            if (this.changes > 0) res.json({ success: true });
            else res.status(400).json({ message: "Insufficient balance" });
        });
    });
});

// 4. Spot Order & Matching
app.post('/api/order', (req, res) => {
    const { user_id, type, coin, price, amount } = req.body;
    db.run(`INSERT INTO p2p_order (user_id, order_type, coin_symbol, fiat_symbol, price, amount) VALUES (?, ?, ?, 'USDT', ?, ?)`, 
    [user_id, type, coin, price, amount], function() {
        const oid = this.lastID;
        // Simple Match Logic: Find opposite type with same price
        const opp = type === 'Buy' ? 'Sell' : 'Buy';
        db.get(`SELECT * FROM p2p_order WHERE order_type = ? AND coin_symbol = ? AND price = ? AND status_orders = 'open' AND user_id != ? LIMIT 1`,
        [opp, coin, price, user_id], (err, match) => {
            if (match) {
                db.run(`UPDATE p2p_order SET status_orders = 'completed' WHERE order_id IN (?, ?)`, [oid, match.order_id]);
                db.run(`INSERT INTO transactions (sender_id, receiver_id, tx_type, coin_symbol, amount) VALUES (?, ?, 'Trade', ?, ?)`, [user_id, match.user_id, coin, amount]);
            }
            res.json({ success: true });
        });
    });
});

app.get('/api/orders', (req, res) => {
    db.all(`SELECT p.*, u.user_name FROM p2p_order p JOIN users u ON p.user_id = u.user_id WHERE p.status_orders = 'open'`, (err, rows) => res.json(rows));
});

app.get('/api/history/:uid', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE sender_id = ? OR receiver_id = ? ORDER BY tx_id DESC`, [req.params.uid, req.params.uid], (err, rows) => res.json(rows));
});

app.post('/api/transfer', (req, res) => {
    const { user_id, amount, from_type, to_type } = req.body;
    const amt = parseFloat(amount);

    db.get(`SELECT spot_wallet_id, funding_wallet_id FROM users WHERE user_id = ?`, [user_id], (err, user) => {
        if (!user) return res.status(404).json({ message: "User not found" });

        const from_id = from_type === 'Spot' ? user.spot_wallet_id : user.funding_wallet_id;
        const to_id = to_type === 'Spot' ? user.spot_wallet_id : user.funding_wallet_id;

        // 1. ตรวจสอบและหักเงินจากกระเป๋าต้นทาง
        db.run(`UPDATE wallets SET balance = balance - ? WHERE wallet_id = ? AND balance >= ?`, [amt, from_id, amt], function(err) {
            if (this.changes === 0) return res.status(400).json({ message: "ยอดเงินไม่เพียงพอ" });

            // 2. เพิ่มเงินในกระเป๋าปลายทาง
            db.run(`UPDATE wallets SET balance = balance + ? WHERE wallet_id = ?`, [amt, to_id], () => {
                
                // 3. บันทึก Transaction การโอน
                db.run(`INSERT INTO transactions (sender_id, receiver_id, tx_type, coin_symbol, amount) 
                        VALUES (?, ?, 'Transfer', 'ASSET', ?)`, [user_id, user_id, amt]);

                res.json({ success: true, message: `โอนจาก ${from_type} ไป ${to_type} สำเร็จ` });
            });
        });
    });
});
// --- [P2P SYSTEM] ---

// ลงประกาศ P2P (ใช้เงินจากกระเป๋า Funding)
app.post('/api/p2p/post', (req, res) => {
    const { user_id, type, coin, price, amount } = req.body;
    // ถ้าเป็นคนขาย ต้องเช็คก่อนว่ามีเหรียญใน Funding มั้ย
    if(type === 'Sell') {
        db.get(`SELECT balance FROM wallets WHERE user_id = ? AND wallet_type = 'Funding' AND coin_symbol = ?`, [user_id, coin], (err, row) => {
            if(!row || row.balance < amount) return res.status(400).json({ message: "เหรียญใน Funding ไม่พอขาย" });
            insertP2P();
        });
    } else {
        insertP2P();
    }

    function insertP2P() {
        db.run(`INSERT INTO p2p_order (user_id, order_type, coin_symbol, fiat_symbol, price, amount) VALUES (?, ?, ?, 'THB', ?, ?)`, 
        [user_id, type, coin, price, amount], () => res.json({ success: true }));
    }
});

app.get('/api/p2p/list', (req, res) => {
    db.all(`SELECT p.*, u.user_name FROM p2p_order p JOIN users u ON p.user_id = u.user_id WHERE p.status_orders = 'open'`, (err, rows) => res.json(rows));
});


app.listen(3000, () => console.log('🚀 Server at http://localhost:3000'));