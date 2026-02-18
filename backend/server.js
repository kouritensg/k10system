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
  origin: 'https://kouritensg.github.io', // Your GitHub Pages
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options(/(.*)/, cors(corsOptions)); 
app.use(express.json()); 

// --- HEALTH CHECK ---
app.get('/', (req, res) => {
  res.send('K10 System Backend is Online!');
});

// ==========================================
// 1. AUTH SYSTEM
// ==========================================

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [users] = await db.execute('SELECT * FROM staff WHERE username = ?', [username]);
    if (users.length === 0) return res.status(400).json({ error: 'Invalid username or password' });

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(400).json({ error: 'Invalid username or password' });

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'secret', { expiresIn: '12h' });
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (error) { res.status(500).json({ error: 'Login error' }); }
});

// ==========================================
// 2. INVENTORY MANAGEMENT
// ==========================================

// Get Inventory with Intelligence (Incoming POs, Preorders)
app.get('/api/inventory/status', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT 
                i.*, 
                i.stock_quantity as in_stock,
                COALESCE((SELECT SUM(poi.ordered_qty) FROM po_items poi JOIN purchase_orders po ON poi.po_id = po.id WHERE poi.inventory_id = i.id AND po.status = 'Ordered'), 0) as qty_ordered,
                COALESCE((SELECT SUM(poi.allocated_qty) FROM po_items poi JOIN purchase_orders po ON poi.po_id = po.id WHERE poi.inventory_id = i.id AND po.status = 'Invoiced'), 0) as qty_allocated,
                (SELECT COUNT(*) FROM po_items poi JOIN purchase_orders po ON poi.po_id = po.id WHERE poi.inventory_id = i.id AND po.status IN ('Ordered', 'Invoiced')) as active_po_count
            FROM inventory i
            ORDER BY i.card_name ASC
        `);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Database Query Failed' }); }
});

// Quick Add Product (Returns object immediately)
app.post('/api/inventory/add', async (req, res) => {
  const { 
    barcode, game_title, product_type, card_id, card_name, set_name, 
    price, cost_price, stock_quantity,
    packs_per_box, boxes_per_case  // <--- NEW FIELDS
  } = req.body;

  try {
    const [result] = await db.execute(
      `INSERT INTO inventory 
      (barcode, game_title, product_type, card_id, card_name, set_name, price, cost_price, stock_quantity, packs_per_box, boxes_per_case) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        barcode || null, game_title, product_type, card_id || null, card_name, set_name || null, 
        price || 0, cost_price || 0, stock_quantity || 0,
        packs_per_box || 1, boxes_per_case || 1 // Save ratios (Default to 1)
      ]
    );
    res.status(201).json({ message: 'Product registered!' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/inventory/:id', async (req, res) => {
  const { price, stock_quantity, cost_price } = req.body;
  try {
    await db.execute('UPDATE inventory SET price = ?, stock_quantity = ?, cost_price = ? WHERE id = ?', [price, stock_quantity, cost_price || 0, req.params.id]);
    res.json({ message: 'Updated!' });
  } catch (error) { res.status(500).json({ error: 'Update failed' }); }
});

app.delete('/api/inventory/:id', async (req, res) => {
    try {
        await db.execute('DELETE FROM inventory WHERE id = ?', [req.params.id]);
        res.json({ message: 'Deleted' });
    } catch (error) { res.status(500).json({ error: 'Delete failed' }); }
});

// ==========================================
// 3. PURCHASING (OUTGOING STOCK)
// ==========================================

app.get('/api/suppliers', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM suppliers ORDER BY name ASC');
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to load suppliers' }); }
});

// Create PO with Auto-ID
app.post('/api/purchase-orders', async (req, res) => {
    const { supplier_id, po_number, items } = req.body;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const finalPONumber = po_number || `PO-${new Date().toISOString().slice(0,10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

        const [po] = await conn.execute('INSERT INTO purchase_orders (supplier_id, po_number, status) VALUES (?,?,?)', [supplier_id, finalPONumber, 'Ordered']);
        for (const i of items) {
            await conn.execute('INSERT INTO po_items (po_id, inventory_id, ordered_qty, unit_cost) VALUES (?,?,?,?)', [po.insertId, i.inventory_id, i.qty, i.cost]);
        }
        await conn.commit();
        res.status(201).json({ message: 'PO Created', po_number: finalPONumber });
    } catch (e) { await conn.rollback(); res.status(500).json({ error: 'Failed to create PO' }); } finally { conn.release(); }
});

// Get PO History (With Filters)
app.get('/api/purchase-orders', async (req, res) => {
    const { limit, search, status, startDate, endDate } = req.query;
    try {
        let query = `
            SELECT po.*, s.name as supplier_name, 
            (SELECT COUNT(*) FROM po_items WHERE po_id = po.id) as total_items,
            (SELECT COALESCE(SUM(ordered_qty * unit_cost), 0) FROM po_items WHERE po_id = po.id) as total_cost
            FROM purchase_orders po JOIN suppliers s ON po.supplier_id = s.id WHERE 1=1
        `;
        const params = [];
        if (search) { query += ` AND (po.po_number LIKE ? OR s.name LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
        if (status) { query += ` AND po.status = ?`; params.push(status); }
        if (startDate) { query += ` AND po.order_date >= ?`; params.push(startDate); }
        if (endDate) { query += ` AND po.order_date <= ?`; params.push(endDate); }
        
        query += ` ORDER BY po.order_date DESC LIMIT ?`;
        params.push(parseInt(limit) || 10);

        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch history' }); }
});

app.get('/api/purchase-orders/:id', async (req, res) => {
    try {
        const [rows] = await db.execute(`SELECT poi.*, i.card_name, i.set_name, i.game_title FROM po_items poi JOIN inventory i ON poi.inventory_id = i.id WHERE poi.po_id = ?`, [req.params.id]);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch details' }); }
});

// ==========================================
// 4. CUSTOMERS (CRM)
// ==========================================

app.get('/api/customers', async (req, res) => {
    const { search } = req.query;
    try {
        let query = 'SELECT * FROM customers';
        let params = [];
        if (search) {
            query += ' WHERE name LIKE ? OR email LIKE ? OR mobile_number LIKE ? OR bandai_id LIKE ?';
            const term = `%${search}%`; params = [term, term, term, term];
        }
        query += ' ORDER BY name ASC';
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch customers' }); }
});

app.post('/api/customers', async (req, res) => {
    const { name, email, mobile_number, bandai_id, bushiroad_id, status } = req.body;
    try {
        const [result] = await db.execute(
            `INSERT INTO customers (name, email, mobile_number, bandai_id, bushiroad_id, status) VALUES (?, ?, ?, ?, ?, ?)`,
            [name, email || null, mobile_number || null, bandai_id || null, bushiroad_id || null, status || 'Active']
        );
        res.status(201).json({ message: 'Customer created!', id: result.insertId });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/customers/:id', async (req, res) => {
    const { name, email, mobile_number, bandai_id, bushiroad_id, status, loyalty_points } = req.body;
    try {
        await db.execute(
            `UPDATE customers SET name=?, email=?, mobile_number=?, bandai_id=?, bushiroad_id=?, status=?, loyalty_points=? WHERE id=?`,
            [name, email || null, mobile_number || null, bandai_id || null, bushiroad_id || null, status, loyalty_points || 0, req.params.id]
        );
        res.json({ message: 'Updated' });
    } catch (error) { res.status(500).json({ error: 'Update failed' }); }
});

app.delete('/api/customers/:id', async (req, res) => {
    try {
        await db.execute('DELETE FROM customers WHERE id = ?', [req.params.id]);
        res.json({ message: 'Deleted' });
    } catch (error) { res.status(500).json({ error: 'Cannot delete (Order linked)' }); }
});

app.get('/api/customers/:id/history', async (req, res) => {
    try {
        const [orders] = await db.execute(`
            SELECT o.id, o.order_date, o.order_type, o.status, o.total_amount, o.deposit_amount,
                   GROUP_CONCAT(CONCAT(i.card_name, ' (x', oi.quantity, ')') SEPARATOR ', ') as items
            FROM customer_orders o JOIN customer_order_items oi ON o.id = oi.order_id JOIN inventory i ON oi.inventory_id = i.id
            WHERE o.customer_id = ? GROUP BY o.id ORDER BY o.order_date DESC
        `, [req.params.id]);
        res.json(orders);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch history' }); }
});

// ==========================================
// 5. SALES & POS SYSTEM (INCOMING MONEY)
// ==========================================

// Create Sale (Deducts stock if 'In-Stock', handles Deposits)
app.post('/api/sales', async (req, res) => {
    const { customer_id, order_type, payment_method, items, custom_status, deposit_amount } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: "No items" });

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
        res.status(201).json({ message: 'Order recorded!', order_id: orderResult.insertId });
    } catch (error) { await conn.rollback(); res.status(500).json({ error: error.message }); } finally { conn.release(); }
});

// Get Active Preorders (With Game Tags & Balance)
app.get('/api/sales/preorders', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT o.id, o.order_date, c.name as customer_name, c.mobile_number, 
                   o.total_amount, o.deposit_amount, o.status,
                   GROUP_CONCAT(CONCAT(i.card_name, ' (x', oi.quantity, ')') SEPARATOR ', ') as items_summary,
                   GROUP_CONCAT(DISTINCT i.game_title) as game_tags
            FROM customer_orders o
            JOIN customers c ON o.customer_id = c.id
            JOIN customer_order_items oi ON o.id = oi.order_id
            JOIN inventory i ON oi.inventory_id = i.id
            WHERE o.order_type = 'Preorder' AND o.status != 'Fulfilled'
            GROUP BY o.id ORDER BY o.order_date ASC
        `);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch preorders' }); }
});

// Mark Preorder as Fulfilled
app.put('/api/sales/:id/fulfill', async (req, res) => {
    try {
        await db.execute("UPDATE customer_orders SET status = 'Fulfilled' WHERE id = ?", [req.params.id]);
        res.json({ message: 'Fulfilled' });
    } catch (error) { res.status(500).json({ error: 'Update failed' }); }
});

// Top-up Payment on Preorder
app.put('/api/sales/:id/payment', async (req, res) => {
    const { amount } = req.body;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.execute('SELECT total_amount, deposit_amount FROM customer_orders WHERE id = ?', [req.params.id]);
        if(rows.length === 0) throw new Error("Order not found");
        
        const newTotalPaid = parseFloat(rows[0].deposit_amount || 0) + parseFloat(amount);
        const totalCost = parseFloat(rows[0].total_amount);
        let newStatus = newTotalPaid >= (totalCost - 0.01) ? 'Paid' : 'Partial';

        await conn.execute('UPDATE customer_orders SET deposit_amount = ?, status = ? WHERE id = ?', [newTotalPaid, newStatus, req.params.id]);
        await conn.commit();
        res.json({ message: 'Payment recorded', new_status: newStatus });
    } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); } finally { conn.release(); }
});

// Full Sales History (Cash Flow)
app.get('/api/sales/history', async (req, res) => {
    const { startDate, endDate } = req.query;
    try {
        let query = `
            SELECT o.id, o.order_date, o.order_type, o.status, o.total_amount, o.deposit_amount, o.payment_method, c.name as customer_name
            FROM customer_orders o JOIN customers c ON o.customer_id = c.id WHERE 1=1
        `;
        const params = [];
        if (startDate) { query += ' AND o.order_date >= ?'; params.push(startDate); }
        if (endDate) { query += ' AND o.order_date <= ?'; params.push(endDate); }
        query += ' ORDER BY o.order_date DESC';
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch sales' }); }
});

// ==========================================
// 6. EVENTS & STORAGE
// ==========================================

app.get('/api/events', async (req, res) => {
    const { admin } = req.query;
    let query = `SELECT * FROM events`;
    if (admin !== 'true') query += ` WHERE event_date >= NOW()`;
    query += ` ORDER BY event_date DESC`;
    try { const [events] = await db.execute(query); res.json(events); } catch (e) { res.status(500).send(); }
});

app.post('/api/events/create', async (req, res) => {
    const { title, game_title, event_date, entry_fee, max_players } = req.body;
    try {
        await db.execute('INSERT INTO events (title, game_title, event_date, entry_fee, max_players) VALUES (?,?,?,?,?)', [title, game_title, event_date, entry_fee, max_players]);
        res.status(201).send();
    } catch (e) { res.status(500).send(); }
});

app.get('/api/storage', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT p.id, c.id as customer_id, c.name, c.contact_info, p.game_title, p.pack_type, p.quantity, p.last_updated
      FROM customer_packs p JOIN customers c ON p.customer_id = c.id WHERE p.quantity > 0 ORDER BY p.last_updated DESC`);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch storage.' }); }
});

app.post('/api/storage/update', async (req, res) => {
  const { customer_id, game_title, pack_type, change_amount } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.execute('SELECT id FROM customer_packs WHERE customer_id = ? AND game_title = ? AND pack_type = ?', [customer_id, game_title, pack_type || 'Standard Booster']);
    if (existing.length > 0) {
      await conn.execute('UPDATE customer_packs SET quantity = quantity + ? WHERE id = ?', [change_amount, existing[0].id]);
    } else {
      await conn.execute('INSERT INTO customer_packs (customer_id, game_title, pack_type, quantity) VALUES (?, ?, ?, ?)', [customer_id, game_title, pack_type || 'Standard Booster', change_amount]);
    }
    await conn.execute('INSERT INTO pack_transactions (customer_id, game_title, pack_type, amount) VALUES (?, ?, ?, ?)', [customer_id, game_title, pack_type || 'Standard Booster', change_amount]);
    await conn.commit();
    res.json({ message: 'Storage updated!' });
  } catch (error) { await conn.rollback(); res.status(500).json({ error: error.message }); } finally { conn.release(); }
});

// --- KEEP ALIVE ---
setInterval(async () => { try { await db.execute('SELECT 1'); } catch(e){} }, 300000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
