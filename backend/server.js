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
// 2. CATEGORY MANAGEMENT (NEW RELATIONAL LOGIC)
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
    } catch (error) { res.status(500).json({ error: 'Cannot delete. Category might be linked to products.' }); }
});

// ==========================================
// 3. SUPPLIER MANAGEMENT
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
        const [result] = await db.execute(
            `INSERT INTO suppliers (name, contact_person, email, phone, payment_terms) VALUES (?, ?, ?, ?, ?)`,
            [name, contact_person || null, email || null, phone || null, payment_terms || 'Immediate']
        );
        res.status(201).json({ id: result.insertId, message: 'Supplier created' });
    } catch (error) { res.status(500).json({ error: 'Database error' }); }
});

app.delete('/api/suppliers/:id', async (req, res) => {
    try {
        await db.execute('DELETE FROM suppliers WHERE id = ?', [req.params.id]);
        res.json({ message: 'Supplier deleted' });
    } catch (error) { res.status(500).json({ error: 'Cannot delete. Supplier might be linked to orders.' }); }
});

// ==========================================
// 4. INVENTORY (FIXED FOR CATEGORY_ID)
// ==========================================

// Public Route (Used by index.html)
app.get('/api/inventory', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT i.*, c.name as category_name 
            FROM inventory i 
            LEFT JOIN categories c ON i.category_id = c.id 
            WHERE i.stock_quantity >= 0 
            ORDER BY c.name, i.card_name ASC`
        );
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch inventory' }); }
});

// Admin Route (Used by admin-inventory.html)
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
  const { price, stock_quantity, cost_price, category_id } = req.body;
  try {
    await db.execute(
        'UPDATE inventory SET price = ?, stock_quantity = ?, cost_price = ?, category_id = ? WHERE id = ?', 
        [price, stock_quantity, cost_price || 0, category_id, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (error) { res.status(500).json({ error: 'Update failed' }); }
});

app.delete('/api/inventory/:id', async (req, res) => {
    try {
        await db.execute('DELETE FROM inventory WHERE id = ?', [req.params.id]);
        res.json({ message: 'Deleted' });
    } catch (error) { res.status(500).json({ error: 'Delete failed' }); }
});

// ==========================================
// 5. PURCHASING MODULE
// ==========================================
app.post('/api/purchase-orders', async (req, res) => {
    const { supplier_id, po_number, items, payment_status, total_cost, deposit_paid, paid_amount } = req.body;
    const conn = await db.getConnection();
    
    try {
        await conn.beginTransaction();
        
        // Use current date if none provided
        const orderDate = new Date().toISOString().slice(0, 10); 
        const finalPONumber = po_number || `PO-${Date.now()}`;

        // UPDATED: Matches your current DB structure
        const [po] = await conn.execute(
            `INSERT INTO purchase_orders 
            (supplier_id, po_number, order_date, status, payment_status, total_cost, deposit_paid, paid_amount) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
            [
                supplier_id, 
                finalPONumber, 
                orderDate, 
                'Ordered', 
                payment_status || 'Pending', 
                total_cost || 0, 
                deposit_paid || 0, 
                paid_amount || 0
            ]
        );

        // Insert items into po_items
        for (const i of items) {
            await conn.execute(
                'INSERT INTO po_items (po_id, inventory_id, ordered_qty, unit_cost) VALUES (?, ?, ?, ?)', 
                [po.insertId, i.inventory_id, i.qty, i.cost]
            );
        }

        await conn.commit();
        res.status(201).json({ message: 'PO Created', po_number: finalPONumber });
    } catch (e) { 
        await conn.rollback(); 
        console.error("PO Error:", e.message); // This will show the exact DB error in your Render logs
        res.status(500).json({ error: e.message }); 
    } finally { 
        conn.release(); 
    }
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

app.get('/api/purchase-orders/:id', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT poi.*, i.card_name, i.game_title 
            FROM po_items poi JOIN inventory i ON poi.inventory_id = i.id WHERE poi.po_id = ?`, 
            [req.params.id]
        );
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

// ==========================================
// 6. SALES & PREORDERS
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

app.get('/api/sales/history', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT o.*, c.name as customer_name FROM customer_orders o 
            JOIN customers c ON o.customer_id = c.id ORDER BY o.order_date DESC`);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/sales/preorders', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT o.id, o.order_date, c.name as customer_name, c.mobile_number, o.total_amount, o.deposit_amount, o.status,
                   GROUP_CONCAT(CONCAT(i.card_name, ' (x', oi.quantity, ')') SEPARATOR ', ') as items_summary,
                   GROUP_CONCAT(DISTINCT i.game_title) as game_tags
            FROM customer_orders o 
            JOIN customers c ON o.customer_id = c.id 
            JOIN customer_order_items oi ON o.id = oi.order_id 
            JOIN inventory i ON oi.inventory_id = i.id
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


// ==========================================
// CUSTOMER MANAGEMENT
// ==========================================

// Get all customers (with optional search)
app.get('/api/customers', async (req, res) => {
    const { search } = req.query;
    try {
        let query = 'SELECT * FROM customers';
        let params = [];
        
        if (search) {
            query += ' WHERE name LIKE ? OR email LIKE ? OR mobile_number LIKE ? OR bandai_id LIKE ? OR bushiroad_id LIKE ?';
            const searchVal = `%${search}%`;
            params = [searchVal, searchVal, searchVal, searchVal, searchVal];
        }
        
        query += ' ORDER BY name ASC';
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// Add new customer
app.post('/api/customers', async (req, res) => {
    const { name, email, mobile_number, bandai_id, bushiroad_id } = req.body;
    try {
        const [result] = await db.execute(
            `INSERT INTO customers (name, email, mobile_number, bandai_id, bushiroad_id, status, loyalty_points) 
             VALUES (?, ?, ?, ?, ?, 'Active', 0)`,
            [name, email || null, mobile_number || null, bandai_id || null, bushiroad_id || null]
        );
        res.status(201).json({ id: result.insertId, message: 'Customer created' });
    } catch (error) {
        res.status(500).json({ error: 'Database error or duplicate entry' });
    }
});

// Get detailed purchase history for a specific customer
app.get('/api/customers/:id/history', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT o.*, 
                   GROUP_CONCAT(CONCAT(i.card_name, ' (x', oi.quantity, ')') SEPARATOR ', ') as items
            FROM customer_orders o
            JOIN customer_order_items oi ON o.id = oi.order_id
            JOIN inventory i ON oi.inventory_id = i.id
            WHERE o.customer_id = ?
            GROUP BY o.id
            ORDER BY o.order_date DESC`, 
            [req.params.id]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

// Delete customer
app.delete('/api/customers/:id', async (req, res) => {
    try {
        await db.execute('DELETE FROM customers WHERE id = ?', [req.params.id]);
        res.json({ message: 'Customer deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Cannot delete: Customer has existing orders.' });
    }
});

// ==========================================
// UPDATED PURCHASING ROUTES
// ==========================================

// 1. Get Purchase Order History (Including Invoice Data)
app.get('/api/purchase-orders', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT 
                po.id, 
                po.po_number, 
                po.status, 
                po.order_date,
                po.payment_status,
                po.total_cost,
                po.paid_amount,
                po.invoice_no,
                po.payment_date,
                COALESCE(s.name, 'Unknown Supplier') as supplier_name,
                -- Calculated value from items (for reference)
                (SELECT SUM(poi.ordered_qty * poi.unit_cost) FROM po_items poi WHERE poi.po_id = po.id) as original_value
            FROM purchase_orders po 
            LEFT JOIN suppliers s ON po.supplier_id = s.id 
            ORDER BY po.order_date DESC`
        );
        res.json(rows);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2. New Route: Record Payment & Invoice
app.put('/api/purchase-orders/:id/payment', async (req, res) => {
    const { invoice_no, payment_date, amount_paid, final_total_cost } = req.body;
    try {
        // Update the PO header with actual financial data
        await db.execute(
            `UPDATE purchase_orders 
             SET invoice_no = ?, 
                 payment_date = ?, 
                 paid_amount = paid_amount + ?, 
                 total_cost = ?,
                 payment_status = CASE WHEN (paid_amount + ?) >= ? THEN 'Fully Paid' ELSE 'Partial' END
             WHERE id = ?`,
            [
                invoice_no || null, 
                payment_date || null, 
                parseFloat(amount_paid) || 0, 
                parseFloat(final_total_cost), 
                parseFloat(amount_paid) || 0, 
                parseFloat(final_total_cost), 
                req.params.id
            ]
        );
        res.json({ message: 'Payment recorded successfully' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- KEEP ALIVE ---
setInterval(async () => { try { await db.execute('SELECT 1'); } catch(e){} }, 300000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
