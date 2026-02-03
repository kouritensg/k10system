require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db'); 

const app = express();

// --- 1. CONFIGURATION ---
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

// --- 2. HEALTH CHECK ---
app.get('/', (req, res) => {
  res.send('K10 System Backend is Online and Connected to Aiven Cloud MySQL!');
});

// ==========================================
// AUTH SYSTEM (Staff)
// ==========================================

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [users] = await db.execute('SELECT * FROM staff WHERE username = ?', [username]);
    if (users.length === 0) return res.status(400).json({ error: 'Invalid username or password' });

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(400).json({ error: 'Invalid username or password' });

    const token = jwt.sign(
      { id: user.id, role: user.role }, 
      process.env.JWT_SECRET || 'fallback_secret', 
      { expiresIn: '8h' } 
    );

    res.json({
      token: token,
      user: { id: user.id, username: user.username, role: user.role }
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error during login' });
  }
});

// ==========================================
// INVENTORY SYSTEM (Upgraded for Cost Price)
// ==========================================

app.get('/api/inventory', async (req, res) => {
  try {
    const [products] = await db.execute('SELECT * FROM inventory ORDER BY created_at DESC');
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

app.post('/api/inventory/add', async (req, res) => {
  const { 
    barcode, game_title, product_type, card_id, card_name, set_name, rarity, price, cost_price, stock_quantity 
  } = req.body;

  try {
    const [result] = await db.execute(
      `INSERT INTO inventory 
      (barcode, game_title, product_type, card_id, card_name, set_name, rarity, price, cost_price, stock_quantity) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [barcode || null, game_title, product_type, card_id || null, card_name, set_name || null, rarity || null, price, cost_price || 0, stock_quantity]
    );
    res.status(201).json({ message: 'Product added successfully!', id: result.insertId });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Barcode/ID already exists.' });
    res.status(500).json({ error: 'Failed to add product' });
  }
});

app.put('/api/inventory/:id', async (req, res) => {
  const { id } = req.params;
  const { price, stock_quantity, cost_price } = req.body;
  try {
    await db.execute(
      'UPDATE inventory SET price = ?, stock_quantity = ?, cost_price = ? WHERE id = ?',
      [price, stock_quantity, cost_price || 0, id]
    );
    res.json({ message: 'Product updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.delete('/api/inventory/:id', async (req, res) => {
  try {
    await db.execute('DELETE FROM inventory WHERE id = ?', [req.params.id]);
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Specialized Inventory View: Live Stock vs Pipeline
app.get('/api/inventory/status', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT 
                i.id, i.card_name, i.set_name, i.game_title, i.product_type, i.card_id,
                i.stock_quantity as in_stock, i.price, i.cost_price,
                COALESCE(SUM(CASE WHEN po.status = 'Ordered' THEN poi.ordered_qty ELSE 0 END), 0) as qty_ordered,
                COALESCE(SUM(CASE WHEN po.status = 'Invoiced' THEN poi.allocated_qty ELSE 0 END), 0) as qty_allocated,
                COUNT(DISTINCT CASE WHEN po.status IN ('Ordered', 'Invoiced') THEN po.id END) as active_po_count
            FROM inventory i
            LEFT JOIN po_items poi ON i.id = poi.inventory_id
            LEFT JOIN purchase_orders po ON poi.po_id = po.id AND po.status IN ('Ordered', 'Invoiced')
            GROUP BY i.id
            ORDER BY active_po_count DESC, i.card_name ASC
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch inventory status' });
    }
});

// ==========================================
// SUPPLIER & PURCHASE ORDER SYSTEM
// ==========================================

app.get('/api/suppliers', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM suppliers ORDER BY name ASC');
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch suppliers' }); }
});

app.post('/api/suppliers', async (req, res) => {
    const { name, contact_person, email, phone, payment_terms } = req.body;
    try {
        await db.execute(
            'INSERT INTO suppliers (name, contact_person, email, phone, payment_terms) VALUES (?, ?, ?, ?, ?)',
            [name, contact_person, email, phone, payment_terms]
        );
        res.status(201).json({ message: 'Supplier added!' });
    } catch (error) { res.status(500).json({ error: 'Failed to add supplier' }); }
});

app.post('/api/purchase-orders', async (req, res) => {
    const { supplier_id, po_number, items } = req.body;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [po] = await connection.execute(
            'INSERT INTO purchase_orders (supplier_id, po_number, status) VALUES (?, ?, ?)',
            [supplier_id, po_number || `PO-${Date.now()}`, 'Ordered']
        );
        const poId = po.insertId;
        for (const item of items) {
            await connection.execute(
                'INSERT INTO po_items (po_id, inventory_id, ordered_qty, unit_cost) VALUES (?, ?, ?, ?)',
                [poId, item.inventory_id, item.qty, item.cost]
            );
        }
        await connection.commit();
        res.status(201).json({ message: 'PO created!' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: 'Failed to create PO' });
    } finally { connection.release(); }
});

// ==========================================
// CUSTOMER & EVENT SYSTEM
// ==========================================

app.get('/api/customers/search', async (req, res) => {
    const { q } = req.query;
    try {
        const [rows] = await db.execute('SELECT id, name, contact_info FROM customers WHERE name LIKE ? LIMIT 5', [`%${q}%`]);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Search failed' }); }
});

app.get('/api/customers/:id/recent-events', async (req, res) => {
    try {
        const [events] = await db.execute(`
            SELECT e.id, e.title, e.game_title, e.event_date FROM event_registrations r
            JOIN events e ON r.event_id = e.id WHERE r.customer_id = ?
            ORDER BY e.event_date DESC LIMIT 5`, [req.params.id]);
        res.json(events);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch history' }); }
});

// ==========================================
// PACK STORAGE SYSTEM
// ==========================================

app.get('/api/storage', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT p.id, c.id as customer_id, c.name, c.contact_info, p.game_title, p.pack_type, p.quantity, p.last_updated
      FROM customer_packs p JOIN customers c ON p.customer_id = c.id
      WHERE p.quantity > 0 ORDER BY p.last_updated DESC`);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch storage.' }); }
});

app.get('/api/storage/history/:customerId', async (req, res) => {
    try {
        const [history] = await db.execute(`
            SELECT t.transaction_date, t.game_title, t.pack_type, t.amount, e.title as event_name, e.event_date 
            FROM pack_transactions t LEFT JOIN events e ON t.event_id = e.id
            WHERE t.customer_id = ? ORDER BY t.transaction_date DESC`, [req.params.customerId]);
        res.json(history);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch history' }); }
});

app.post('/api/storage/update', async (req, res) => {
  const { customer_id, game_title, pack_type, change_amount, event_id } = req.body;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    if (change_amount > 0) {
        const [reg] = await connection.execute('SELECT id FROM event_registrations WHERE customer_id = ? AND event_id = ?', [customer_id, event_id]);
        if (reg.length === 0) throw new Error("Customer did NOT join that event.");
    }
    const [existing] = await connection.execute('SELECT id, quantity FROM customer_packs WHERE customer_id = ? AND game_title = ? AND pack_type = ?', [customer_id, game_title, pack_type || 'Standard Booster']);
    if (existing.length > 0) {
      await connection.execute('UPDATE customer_packs SET quantity = quantity + ? WHERE id = ?', [change_amount, existing[0].id]);
    } else {
      await connection.execute('INSERT INTO customer_packs (customer_id, game_title, pack_type, quantity) VALUES (?, ?, ?, ?)', [customer_id, game_title, pack_type || 'Standard Booster', change_amount]);
    }
    await connection.execute('INSERT INTO pack_transactions (customer_id, game_title, pack_type, amount, event_id) VALUES (?, ?, ?, ?, ?)', [customer_id, game_title, pack_type || 'Standard Booster', change_amount, event_id || null]);
    await connection.commit();
    res.json({ message: 'Storage updated!' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally { connection.release(); }
});

// --- KEEP-ALIVE ---
setInterval(async () => {
  try { await db.execute('SELECT 1'); } catch (error) { console.error('Ping failed'); }
}, 5 * 60 * 1000); 

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
