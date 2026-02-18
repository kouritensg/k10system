require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db'); 

const app = express();
const PORT = process.env.PORT || 5000;

// --- CONFIGURATION ---
const corsOptions = {
  origin: 'https://kouritensg.github.io', 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options(/(.*)/, cors(corsOptions)); 
app.use(express.json()); 

// ==========================================
// 1. AUTH SYSTEM
// ==========================================

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [users] = await db.execute('SELECT * FROM staff WHERE username = ?', [username]);
    if (users.length === 0) return res.status(400).json({ error: 'Invalid login' });

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(400).json({ error: 'Invalid login' });

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'secret', { expiresIn: '12h' });
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (error) { res.status(500).json({ error: 'Login error' }); }
});

// ==========================================
// 2. SUPPLIER MANAGEMENT (MATCHED TO DB)
// ==========================================

app.get('/api/suppliers', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM suppliers ORDER BY name ASC');
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch suppliers' }); }
});

app.post('/api/suppliers', async (req, res) => {
    const { name, contact_person, email, phone, payment_terms } = req.body;
    if (!name) return res.status(400).json({ error: 'Supplier name is required' });

    try {
        const [result] = await db.execute(
            `INSERT INTO suppliers (name, contact_person, email, phone, payment_terms) 
             VALUES (?, ?, ?, ?, ?)`,
            [name, contact_person || null, email || null, phone || null, payment_terms || 'Immediate']
        );
        res.status(201).json({ id: result.insertId, message: 'Supplier created' });
    } catch (error) { res.status(500).json({ error: 'Database error: ' + error.message }); }
});

app.delete('/api/suppliers/:id', async (req, res) => {
    try {
        await db.execute('DELETE FROM suppliers WHERE id = ?', [req.params.id]);
        res.json({ message: 'Supplier deleted' });
    } catch (error) { res.status(500).json({ error: 'Cannot delete. Supplier might be linked to orders.' }); }
});

// ==========================================
// 3. INVENTORY (WITH UNIT RATIOS)
// ==========================================

app.get('/api/inventory/status', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM inventory ORDER BY card_name ASC');
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Database Query Failed' }); }
});

app.post('/api/inventory/add', async (req, res) => {
  const { barcode, game_title, product_type, card_id, card_name, price, cost_price, stock_quantity, packs_per_box, boxes_per_case } = req.body;
  try {
    const [result] = await db.execute(
      `INSERT INTO inventory (barcode, game_title, product_type, card_id, card_name, price, cost_price, stock_quantity, packs_per_box, boxes_per_case) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [barcode || null, game_title, product_type, card_id || null, card_name, price || 0, cost_price || 0, stock_quantity || 0, packs_per_box || 1, boxes_per_case || 1]
    );

    // NEW: Fetch the newly created product to send back to the frontend
    const [newProduct] = await db.execute('SELECT * FROM inventory WHERE id = ?', [result.insertId]);
    
    res.status(201).json({ 
        message: 'Product registered!', 
        product: newProduct[0] // Frontend needs this to add to basket
    });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

app.put('/api/inventory/:id', async (req, res) => {
  const { price, stock_quantity, cost_price } = req.body;
  try {
    await db.execute('UPDATE inventory SET price = ?, stock_quantity = ?, cost_price = ? WHERE id = ?', [price, stock_quantity, cost_price || 0, req.params.id]);
    res.json({ message: 'Updated' });
  } catch (error) { res.status(500).json({ error: 'Update failed' }); }
});

// ==========================================
// 4. SALES & PREORDERS (WITH DEPOSITS)
// ==========================================

app.post('/api/sales', async (req, res) => {
    const { customer_id, order_type, payment_method, items, custom_status, deposit_amount } = req.body;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const total = items.reduce((sum, item) => sum + (item.qty * item.price), 0);
        let finalStatus = custom_status || 'Paid';
        let finalDeposit = parseFloat(deposit_amount || 0);
        if (finalDeposit >= total) { finalStatus = 'Paid'; finalDeposit = total; }

        const [orderResult] = await conn.execute(
            `INSERT INTO customer_orders (customer_id, order_type, status, total_amount, deposit_amount, payment_method) VALUES (?, ?, ?, ?, ?, ?)`,
            [customer_id, order_type, finalStatus, total, finalDeposit, payment_method]
        );

        for (const item of items) {
            await conn.execute('INSERT INTO customer_order_items (order_id, inventory_id, quantity, unit_price) VALUES (?, ?, ?, ?)', [orderResult.insertId, item.id, item.qty, item.price]);
            if (order_type === 'In-Stock') {
                await conn.execute('UPDATE inventory SET stock_quantity = stock_quantity - ? WHERE id = ?', [item.qty, item.id]);
            }
        }
        await conn.commit();
        res.status(201).json({ message: 'Order recorded!' });
    } catch (error) { await conn.rollback(); res.status(500).json({ error: error.message }); } finally { conn.release(); }
});

app.get('/api/sales/preorders', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT o.id, o.order_date, c.name as customer_name, c.mobile_number, o.total_amount, o.deposit_amount, o.status,
                   GROUP_CONCAT(CONCAT(i.card_name, ' (x', oi.quantity, ')') SEPARATOR ', ') as items_summary,
                   GROUP_CONCAT(DISTINCT i.game_title) as game_tags
            FROM customer_orders o JOIN customers c ON o.customer_id = c.id JOIN customer_order_items oi ON o.id = oi.order_id JOIN inventory i ON oi.inventory_id = i.id
            WHERE o.order_type = 'Preorder' AND o.status != 'Fulfilled'
            GROUP BY o.id ORDER BY o.order_date ASC`);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/sales/:id/payment', async (req, res) => {
    const { amount } = req.body;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.execute('SELECT total_amount, deposit_amount FROM customer_orders WHERE id = ?', [req.params.id]);
        const newTotalPaid = parseFloat(rows[0].deposit_amount || 0) + parseFloat(amount);
        const newStatus = newTotalPaid >= (parseFloat(rows[0].total_amount) - 0.01) ? 'Paid' : 'Partial';
        await conn.execute('UPDATE customer_orders SET deposit_amount = ?, status = ? WHERE id = ?', [newTotalPaid, newStatus, req.params.id]);
        await conn.commit();
        res.json({ message: 'Payment recorded' });
    } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); } finally { conn.release(); }
});

// --- KEEP ALIVE ---
setInterval(async () => { try { await db.execute('SELECT 1'); } catch(e){} }, 300000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
