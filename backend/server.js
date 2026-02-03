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

// FIXED: Comprehensive GROUP BY for strict MySQL environments
app.get('/api/inventory/status', async (req, res) => {
    try {
        // Simpler query to prevent 500 errors
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
        // THIS IS THE IMPORTANT PART: Look at your Render Logs for this!
        console.error("CRITICAL SQL ERROR:", error); 
        res.status(500).json({ error: 'Database Query Failed', message: error.message });
    }
});

app.post('/api/inventory/add', async (req, res) => {
  const { barcode, game_title, product_type, card_id, card_name, set_name, price, cost_price, stock_quantity } = req.body;
  try {
    await db.execute(
      `INSERT INTO inventory (barcode, game_title, product_type, card_id, card_name, set_name, price, cost_price, stock_quantity) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [barcode || null, game_title, product_type, card_id || null, card_name, set_name || null, price, cost_price || 0, stock_quantity]
    );
    res.status(201).json({ message: 'Added!' });
  } catch (error) { res.status(500).json({ error: error.message }); }
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
    const [rows] = await db.execute('SELECT * FROM suppliers ORDER BY name ASC');
    res.json(rows);
});

app.post('/api/suppliers', async (req, res) => {
    const { name, contact_person, email, payment_terms } = req.body;
    await db.execute('INSERT INTO suppliers (name, contact_person, email, payment_terms) VALUES (?,?,?,?)', [name, contact_person, email, payment_terms]);
    res.status(201).send();
});

app.post('/api/purchase-orders', async (req, res) => {
    const { supplier_id, po_number, items } = req.body;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [po] = await conn.execute('INSERT INTO purchase_orders (supplier_id, po_number, status) VALUES (?,?,?)', [supplier_id, po_number || `PO-${Date.now()}`, 'Ordered']);
        for (const i of items) {
            await conn.execute('INSERT INTO po_items (po_id, inventory_id, ordered_qty, unit_cost) VALUES (?,?,?,?)', [po.insertId, i.inventory_id, i.qty, i.cost]);
        }
        await conn.commit();
        res.status(201).send();
    } catch (e) { await conn.rollback(); res.status(500).send(); }
    finally { conn.release(); }
});

// --- KEEP ALIVE ---
setInterval(async () => { try { await db.execute('SELECT 1'); } catch(e){} }, 300000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
