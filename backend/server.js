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
// CUSTOMER CRM SYSTEM (Official Phase 1)
// ==========================================

// 1. GET: List Customers (with Search)
app.get('/api/customers', async (req, res) => {
    const { search } = req.query;
    try {
        let query = 'SELECT * FROM customers';
        let params = [];

        if (search) {
            query += ' WHERE name LIKE ? OR email LIKE ? OR mobile_number LIKE ? OR bandai_id LIKE ?';
            const term = `%${search}%`;
            params = [term, term, term, term];
        }

        query += ' ORDER BY name ASC';
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// 2. POST: Create New Customer
app.post('/api/customers', async (req, res) => {
    const { name, email, mobile_number, bandai_id, bushiroad_id, status } = req.body;

    if (!name || (!email && !mobile_number)) {
        return res.status(400).json({ error: 'Name and at least one contact method (Email/Mobile) are required.' });
    }

    try {
        const [result] = await db.execute(
            `INSERT INTO customers (name, email, mobile_number, bandai_id, bushiroad_id, status) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [name, email || null, mobile_number || null, bandai_id || null, bushiroad_id || null, status || 'Active']
        );
        res.status(201).json({ message: 'Customer profile created!', id: result.insertId });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Email or Mobile Number already exists.' });
        }
        res.status(500).json({ error: 'Database error: ' + error.message });
    }
});

// 3. PUT: Update Customer
app.put('/api/customers/:id', async (req, res) => {
    const { id } = req.params;
    const { name, email, mobile_number, bandai_id, bushiroad_id, status, loyalty_points } = req.body;

    try {
        await db.execute(
            `UPDATE customers SET 
             name=?, email=?, mobile_number=?, bandai_id=?, bushiroad_id=?, status=?, loyalty_points=? 
             WHERE id=?`,
            [name, email || null, mobile_number || null, bandai_id || null, bushiroad_id || null, status, loyalty_points || 0, id]
        );
        res.json({ message: 'Customer updated successfully' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Email or Mobile Number is already taken by another user.' });
        }
        res.status(500).json({ error: 'Update failed' });
    }
});

// 4. DELETE: Remove Customer
app.delete('/api/customers/:id', async (req, res) => {
    try {
        await db.execute('DELETE FROM customers WHERE id = ?', [req.params.id]);
        res.json({ message: 'Customer deleted' });
    } catch (error) {
        // If they are linked to sales or events, this might fail (which is good for safety)
        res.status(500).json({ error: 'Cannot delete customer. They may have active orders or event history.' });
    }
});

// ==========================================
// CUSTOMER SALES / POS SYSTEM
// ==========================================
app.post('/api/sales', async (req, res) => {
    // added custom_status and deposit_amount to the input
    const { customer_id, order_type, payment_method, items, custom_status, deposit_amount } = req.body;
    
    if (!items || items.length === 0) return res.status(400).json({ error: "No items in cart" });

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // 1. Calculate Grand Total
        const total = items.reduce((sum, item) => sum + (item.qty * item.price), 0);

        // 2. Determine Final Status
        // If the user manually sent a status (like 'Pending' or 'Partial'), use it.
        // Otherwise, default to 'Paid' for normal sales.
        let finalStatus = custom_status || 'Paid';
        let finalDeposit = parseFloat(deposit_amount || 0);

        // Logic check: If they paid the full amount, mark as Paid
        if (finalDeposit >= total) {
            finalStatus = 'Paid';
            finalDeposit = total;
        }

        // 3. Create Order Header
        const [orderResult] = await conn.execute(
            `INSERT INTO customer_orders (customer_id, order_type, status, total_amount, deposit_amount, payment_method) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [customer_id, order_type, finalStatus, total, finalDeposit, payment_method]
        );
        const orderId = orderResult.insertId;

        // 4. Process Items
        for (const item of items) {
            await conn.execute(
                `INSERT INTO customer_order_items (order_id, inventory_id, quantity, unit_price) 
                 VALUES (?, ?, ?, ?)`,
                [orderId, item.id, item.qty, item.price]
            );

            // ONLY deduct stock if it is a "In-Stock" purchase
            if (order_type === 'In-Stock') {
                await conn.execute(
                    'UPDATE inventory SET stock_quantity = stock_quantity - ? WHERE id = ?', 
                    [item.qty, item.id]
                );
            }
        }

        await conn.commit();
        res.status(201).json({ message: 'Order recorded!', order_id: orderId });

    } catch (error) {
        await conn.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        conn.release();
    }
});

// ==========================================
// Customer ORDER HISTORY & Customer PREORDER MANAGEMENT
// ==========================================

// 1. Get Active Preorders (Updated to fetch deposit)
app.get('/api/sales/preorders', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT o.id, o.order_date, c.name as customer_name, c.mobile_number, 
                   o.total_amount, o.deposit_amount, o.status,
                   GROUP_CONCAT(CONCAT(i.card_name, ' (x', oi.quantity, ')') SEPARATOR ', ') as items_summary
            FROM customer_orders o
            JOIN customers c ON o.customer_id = c.id
            JOIN customer_order_items oi ON o.id = oi.order_id
            JOIN inventory i ON oi.inventory_id = i.id
            WHERE o.order_type = 'Preorder' AND o.status != 'Fulfilled'
            GROUP BY o.id
            ORDER BY o.order_date ASC
        `);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch preorders' }); }
});

// 2. Get Customer History (Updated to fetch deposit)
app.get('/api/customers/:id/history', async (req, res) => {
    try {
        const [orders] = await db.execute(`
            SELECT o.id, o.order_date, o.order_type, o.status, o.total_amount, o.deposit_amount,
                   GROUP_CONCAT(CONCAT(i.card_name, ' (x', oi.quantity, ')') SEPARATOR ', ') as items
            FROM customer_orders o
            JOIN customer_order_items oi ON o.id = oi.order_id
            JOIN inventory i ON oi.inventory_id = i.id
            WHERE o.customer_id = ?
            GROUP BY o.id
            ORDER BY o.order_date DESC
        `, [req.params.id]);
        res.json(orders);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch history' }); }
});

// 3. Mark Preorder as Fulfilled (When stock arrives)
app.put('/api/sales/:id/fulfill', async (req, res) => {
    try {
        await db.execute("UPDATE customer_orders SET status = 'Fulfilled' WHERE id = ?", [req.params.id]);
        res.json({ message: 'Order Fulfilled' });
    } catch (error) { res.status(500).json({ error: 'Update failed' }); }
});
// --- KEEP ALIVE ---
setInterval(async () => { try { await db.execute('SELECT 1'); } catch(e){} }, 300000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
