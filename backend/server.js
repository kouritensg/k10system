require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db'); 

const app = express();
const PORT = process.env.PORT || 5000;

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
// 2. CATEGORY MANAGEMENT (NEW)
// ==========================================
app.get('/api/categories', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM categories ORDER BY name ASC');
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch categories' }); }
});

app.post('/api/categories', async (req, res) => {
    const { name } = req.body;
    try {
        const [result] = await db.execute('INSERT INTO categories (name) VALUES (?)', [name]);
        res.status(201).json({ id: result.insertId, message: 'Category added' });
    } catch (error) { res.status(500).json({ error: 'Category already exists or DB error' }); }
});

app.delete('/api/categories/:id', async (req, res) => {
    try {
        await db.execute('DELETE FROM categories WHERE id = ?', [req.params.id]);
        res.json({ message: 'Category deleted' });
    } catch (error) { res.status(500).json({ error: 'Cannot delete: Category is still linked to items.' }); }
});

// ==========================================
// 3. INVENTORY (UPDATED FOR CATEGORY_ID)
// ==========================================
app.get('/api/inventory/status', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT i.*, c.name as category_name 
            FROM inventory i 
            LEFT JOIN categories c ON i.category_id = c.id 
            ORDER BY i.card_name ASC`
        );
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Database Query Failed' }); }
});

app.post('/api/inventory/add', async (req, res) => {
  const { barcode, game_title, category_id, card_id, card_name, price, cost_price, stock_quantity, packs_per_box, boxes_per_case } = req.body;
  try {
    const [result] = await db.execute(
      `INSERT INTO inventory (barcode, game_title, category_id, card_id, card_name, price, cost_price, stock_quantity, packs_per_box, boxes_per_case) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [barcode || null, game_title || null, category_id, card_id || null, card_name, price || 0, cost_price || 0, stock_quantity || 0, packs_per_box || 1, boxes_per_case || 1]
    );
    res.status(201).json({ message: 'Product registered!' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/inventory/:id', async (req, res) => {
  const { price, stock_quantity, cost_price } = req.body;
  try {
    await db.execute('UPDATE inventory SET price = ?, stock_quantity = ?, cost_price = ? WHERE id = ?', [price, stock_quantity, cost_price || 0, req.params.id]);
    res.json({ message: 'Updated' });
  } catch (error) { res.status(500).json({ error: 'Update failed' }); }
});

app.delete('/api/inventory/:id', async (req, res) => {
    try {
        await db.execute('DELETE FROM inventory WHERE id = ?', [req.params.id]);
        res.json({ message: 'Item deleted' });
    } catch (error) { res.status(500).json({ error: 'Delete failed' }); }
});

// ==========================================
// 4. PURCHASING MODULE
// ==========================================
app.post('/api/purchase-orders', async (req, res) => {
    const { supplier_id, po_number, items, payment_status, total_cost, deposit_paid, paid_amount } = req.body;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const finalPONumber = po_number || `PO-${Date.now()}`;
        const [po] = await conn.execute(
            `INSERT INTO purchase_orders (supplier_id, po_number, status, payment_status, total_cost, deposit_paid, paid_amount) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [supplier_id, finalPONumber, 'Ordered', payment_status, total_cost, deposit_paid, paid_amount]
        );
        for (const i of items) {
            await conn.execute('INSERT INTO po_items (po_id, inventory_id, ordered_qty, unit_cost) VALUES (?, ?, ?, ?)', [po.insertId, i.inventory_id, i.qty, i.cost]);
        }
        await conn.commit();
        res.status(201).json({ message: 'PO Created' });
    } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); } finally { conn.release(); }
});

app.get('/api/purchase-orders', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT po.*, s.name as supplier_name,
            (SELECT SUM(poi.ordered_qty * poi.unit_cost) FROM po_items poi WHERE poi.po_id = po.id) as total_value
            FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id ORDER BY po.order_date DESC`);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/purchase-orders/:id/receive', async (req, res) => {
    const { items } = req.body;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        for (let item of items) {
            await conn.execute('UPDATE po_items SET received_qty = received_qty + ? WHERE id = ?', [item.qty_received, item.po_item_id]);
            await conn.execute('UPDATE inventory SET stock_quantity = stock_quantity + ? WHERE id = ?', [item.qty_received, item.inventory_id]);
        }
        await conn.commit();
        res.json({ message: "Stock Updated" });
    } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); } finally { conn.release(); }
});

// ==========================================
// 5. SALES & PREORDERS
// ==========================================
app.post('/api/sales', async (req, res) => {
    const { customer_id, order_type, payment_method, items, custom_status, deposit_amount } = req.body;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const total = items.reduce((sum, item) => sum + (item.qty * item.price), 0);
        const [orderResult] = await conn.execute(
            `INSERT INTO customer_orders (customer_id, order_type, status, total_amount, deposit_amount, payment_method) VALUES (?, ?, ?, ?, ?, ?)`,
            [customer_id, order_type, custom_status || 'Paid', total, deposit_amount || 0, payment_method]
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

// --- KEEP ALIVE ---
setInterval(async () => { try { await db.execute('SELECT 1'); } catch(e){} }, 300000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
