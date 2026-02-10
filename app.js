require('dotenv').config(); // 1. ต้องโหลด Config ก่อนเพื่อน
const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');

const app = express(); // 2. ประกาศสร้าง app ก่อน (ห้ามย้ายไปไหน!)

// 3. Middleware Zone (ต้องอยู่หลังจากประกาศ app)
app.use(express.json());
app.use(express.static('public')); 

// --- [CONFIG] เชื่อมต่อ Database SQLite ---
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './crypto.db',
    logging: false
});

// --- [MODELS] กำหนดโครงสร้างตารางตาม ER Diagram ---
const User = sequelize.define('User', {
    user_name: { type: DataTypes.STRING, allowNull: false },
    email_info: { type: DataTypes.STRING, unique: true }
});

const Wallet = sequelize.define('Wallet', {
    wallet_type: { type: DataTypes.ENUM('Spot', 'Funding'), allowNull: false },
    coin_symbol: { type: DataTypes.STRING, allowNull: false },
    balance: { type: DataTypes.DECIMAL(20, 8), defaultValue: 0 }
});

const P2POrder = sequelize.define('P2POrder', {
    type: { type: DataTypes.ENUM('BUY', 'SELL'), allowNull: false },
    amount: DataTypes.DECIMAL(20, 8),
    price_fiat: DataTypes.DECIMAL(20, 2) 
});

// --- [RELATIONSHIPS] โจทย์ข้อ 2: เขียน Method ความสัมพันธ์ ---
User.hasMany(Wallet, { foreignKey: 'user_id', as: 'wallets' });
Wallet.belongsTo(User, { foreignKey: 'user_id' });

User.hasMany(P2POrder, { foreignKey: 'user_id', as: 'orders' });
P2POrder.belongsTo(User, { foreignKey: 'user_id' });

// --- [SEEDING] ฟังก์ชันสร้างข้อมูลทดสอบ ---
async function seedData() {
    await sequelize.sync({ force: true });
    
    // สร้าง User คนที่ 1
    const somchai = await User.create({ user_name: 'Somchai', email_info: 'somchai@mail.com' });
    await Wallet.bulkCreate([
        { user_id: somchai.id, wallet_type: 'Spot', coin_symbol: 'BTC', balance: 0.5 },
        { user_id: somchai.id, wallet_type: 'Funding', coin_symbol: 'THB', balance: 100000 }
    ]);

    // สร้าง User คนที่ 2 (คนขายเหรียญ)
    const somying = await User.create({ user_name: 'Somying', email_info: 'somying@mail.com' });
    await P2POrder.create({ user_id: somying.id, type: 'SELL', amount: 0.1, price_fiat: 150000 });

    console.log('✅ ข้อมูล Seeding และ Database พร้อมใช้งานแล้ว!');
}

// --- [CONTROLLER & ROUTING] ส่วนหลักของระบบ ---

// 1. ดึงโปรไฟล์ User พร้อมกระเป๋าเงิน
app.get('/user/:id', async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id, { 
            include: [{ model: Wallet, as: 'wallets' }] 
        });
        user ? res.json(user) : res.status(404).json({ message: 'ไม่พบผู้ใช้' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. ดูรายการ P2P ทั้งหมดในระบบ
app.get('/p2p', async (req, res) => {
    try {
        const orders = await P2POrder.findAll({ include: [{ model: User }] });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. จำลองการโอนเหรียญหากัน
app.post('/transfer', (req, res) => {
    const { from_user, to_user, amount, coin } = req.body;
    res.json({ message: `โอน ${amount} ${coin} จาก ID:${from_user} ไปยัง ID:${to_user} สำเร็จ` });
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
seedData().then(() => {
    app.listen(PORT, () => console.log(`🚀 Server รันที่ http://localhost:${PORT}`));
}).catch(err => {
    console.error('❌ ไม่สามารถเริ่มต้นระบบได้:', err);
});