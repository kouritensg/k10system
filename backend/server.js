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
  origin: 'https://kouritensg.github.io', // Your GitHub Pages URL
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
  res.send('K10 System Backend is Online and Connected to Aiven!');
});

// ==========================================
// AUTH SYSTEM
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

    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: 'Server error during login' });
  }
});

// ==========================================
// INVENTORY & INTELLIGENCE
// ==========================================

// Safe Inventory Status Query (Prevents 500 Errors on strict MySQL)
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
    } catch (error) {
        console.error("CRITICAL SQL ERROR:", error); 
        res.status(500).json({ error: 'Database Query Failed', message: error.message });
    }
});

// Quick Add - Returns the new product immediately
app.post('/api/inventory/add', async (req, res) => {
  const { barcode, game_title, product_type, card_id, card_name, set_name, price, cost_price, stock_quantity } = req.body;
  try {
    const [result] = await db.execute(
      `INSERT INTO inventory (barcode, game_title, product_type, card_id, card_name, set_name, price, cost_price, stock_quantity) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [barcode || null, game_title, product_type, card_id || null, card_name, set_name || null, price || 0, cost_price || 0, stock_quantity || 0]
    );

    const [newProduct] = await db.execute('SELECT * FROM inventory WHERE id = ?', [result.insertId]);
    
    res.status(201).json({ 
        message: 'Product registered!', 
        product: {
            ...newProduct[0],
            in_stock: newProduct[0].stock_quantity
        }
    });
  } catch (error) { 
    console.error("Quick Add Error:", error.message);
    res.status(500).json({ error: error.message }); 
  }
});

app.put('/api/inventory/:id', async (req, res) => {
  const { price, stock_quantity, cost_price } = req.body;
  try {
    await db.execute(
      'UPDATE inventory SET price = ?, stock_quantity = ?, cost_price = ? WHERE id = ?',
      [price, stock_quantity, cost_price || 0, req.params.id]
    );
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
// PURCHASING & SUPPLIERS
// ==========================================

app.get('/api/suppliers', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM suppliers ORDER BY name ASC');
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to load suppliers' }); }
});

app.post('/api/suppliers', async (req, res) => {
    const { name, contact_person, email, payment_terms } = req.body;
    try {
        await db.execute('INSERT INTO suppliers (name, contact_person, email, payment_terms) VALUES (?,?,?,?)', [name, contact_person, email, payment_terms]);
        res.status(201).send();
    } catch (error) { res.status(500).json({ error: 'Failed to add supplier' }); }
});

// Create PO with Auto-Generated ID
app.post('/api/purchase-orders', async (req, res) => {
    const { supplier_id, po_number, items } = req.body;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // Auto-Generate ID if blank: PO-20260218-1234
        const dateStr = new Date().toISOString().slice(0,10).replace(/-/g, '');
        const randomSuffix = Math.floor(1000 + Math.random() * 9000);
        const finalPONumber = po_number || `PO-${dateStr}-${randomSuffix}`;

        const [po] = await conn.execute(
            'INSERT INTO purchase_orders (supplier_id, po_number, status) VALUES (?,?,?)', 
            [supplier_id, finalPONumber, 'Ordered']
        );

        for (const i of items) {
            await conn.execute(
                'INSERT INTO po_items (po_id, inventory_id, ordered_qty, unit_cost) VALUES (?,?,?,?)', 
                [po.insertId, i.inventory_id, i.qty, i.cost]
            );
        }

        await conn.commit();
        res.status(201).json({ message: 'PO Created', po_number: finalPONumber });
    } catch (e) { 
        await conn.rollback(); 
        res.status(500).json({ error: 'Failed to create PO' }); 
    } finally { 
        conn.release(); 
    }
});

// Get PO History with Date Filters
app.get('/api/purchase-orders', async (req, res) => {
    const { limit, search, status, startDate, endDate } = req.query;
    try {
        let query = `
            SELECT po.*, s.name as supplier_name, 
            (SELECT COUNT(*) FROM po_items WHERE po_id = po.id) as total_items,
            (SELECT COALESCE(SUM(ordered_qty * unit_cost), 0) FROM po_items WHERE po_id = po.id) as total_cost
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            WHERE 1=1
        `;
        
        const params = [];

        // 1. Filter by Search (ID or Supplier)
        if (search) {
            query += ` AND (po.po_number LIKE ? OR s.name LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }

        // 2. Filter by Status
        if (status) {
            query += ` AND po.status = ?`;
            params.push(status);
        }

        // 3. Filter by Date Range (For Accounting)
        if (startDate) {
            query += ` AND po.order_date >= ?`;
            params.push(startDate);
        }
        if (endDate) {
            query += ` AND po.order_date <= ?`;
            params.push(endDate);
        }
        
        query += ` ORDER BY po.order_date DESC, po.created_at DESC`;
        
        if (limit) {
            query += ` LIMIT ?`;
            params.push(parseInt(limit));
        }

        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (error) {
        console.error("History Error:", error);
        res.status(500).json({ error: 'Failed to fetch PO history' });
    }
});

// ==========================================
// CUSTOMERS & EVENTS
// ==========================================

app.get('/api/customers', async (req, res) => {
    const { search } = req.query;
    let query = 'SELECT * FROM customers';
    let params = [];
    if (search) {
        query += ' WHERE name LIKE ? OR contact_info LIKE ?';
        params = [`%${search}%`, `%${search}%`];
    }
    query += ' ORDER BY created_at DESC';
    try {
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Failed to load customers' }); }
});

app.post('/api/customers/create', async (req, res) => {
    const { name, contact_info } = req.body;
    try {
        const [resDb] = await db.execute('INSERT INTO customers (name, contact_info) VALUES (?, ?)', [name, contact_info]);
        res.status(201).json({ message: 'Created', id: resDb.insertId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

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

app.get('/api/events', async (req, res) => {
    const { admin } = req.query;
    let query = `SELECT * FROM events`;
    if (admin !== 'true') query += ` WHERE event_date >= NOW()`;
    query += ` ORDER BY event_date DESC`;
    try {
        const [events] = await db.execute(query);
        res.json(events);
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/events/create', async (req, res) => {
    const { title, game_title, event_date, entry_fee, max_players } = req.body;
    try {
        await db.execute('INSERT INTO events (title, game_title, event_date, entry_fee, max_players) VALUES (?,?,?,?,?)',
            [title, game_title, event_date, entry_fee, max_players]);
        res.status(201).send();
    } catch (e) { res.status(500).send(); }
});

// ==========================================
// PACK STORAGE
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
    if (change_amount > 0 && event_id) {
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

// --- KEEP ALIVE ---
setInterval(async () => { try { await db.execute('SELECT 1'); } catch(e){} }, 300000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
