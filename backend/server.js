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
app.use(express.json()); 

// --- AUTH, SUPPLIERS, & INVENTORY ROUTES (Omitted for brevity, keep your existing ones) ---

// ==========================================
// PURCHASING MODULE (PO & FINANCIALS)
// ==========================================

// 1. Create New PO with Financial Strategy
app.post('/api/purchase-orders', async (req, res) => {
    const { supplier_id, po_number, items, payment_status, total_cost, deposit_paid, paid_amount } = req.body;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const finalPONumber = po_number || `PO-${Date.now()}`;

        const [po] = await conn.execute(
            `INSERT INTO purchase_orders 
            (supplier_id, po_number, status, payment_status, total_cost, deposit_paid, paid_amount) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [supplier_id, finalPONumber, 'Ordered', payment_status, total_cost, deposit_paid, paid_amount]
        );

        for (const i of items) {
            await conn.execute(
                'INSERT INTO po_items (po_id, inventory_id, ordered_qty, unit_cost) VALUES (?, ?, ?, ?)', 
                [po.insertId, i.inventory_id, i.qty, i.cost]
            );
        }
        await conn.commit();
        res.status(201).json({ po_number: finalPONumber });
    } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); } finally { conn.release(); }
});

// 2. Get PO History with Calculated Totals
app.get('/api/purchase-orders', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT po.*, s.name as supplier_name,
            (SELECT SUM(poi.ordered_qty * poi.unit_cost) FROM po_items poi WHERE poi.po_id = po.id) as calculated_total,
            (SELECT GROUP_CONCAT(CONCAT(i.card_name, ' (x', poi.ordered_qty, ')') SEPARATOR ', ')
             FROM po_items poi JOIN inventory i ON poi.inventory_id = i.id WHERE poi.po_id = po.id) as items_summary
            FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id ORDER BY po.order_date DESC`);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 3. Update Payment (For Preorder Invoices)
app.put('/api/purchase-orders/:id/payment', async (req, res) => {
    const { amount } = req.body;
    try {
        await db.execute('UPDATE purchase_orders SET paid_amount = paid_amount + ? WHERE id = ?', [amount, req.params.id]);
        res.json({ message: "Payment updated" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Full Stock-In Receipt (Confirm Delivery)
app.put('/api/purchase-orders/:id/receive-all', async (req, res) => {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [items] = await conn.execute('SELECT inventory_id, ordered_qty FROM po_items WHERE po_id = ?', [req.params.id]);
        for (let item of items) {
            await conn.execute('UPDATE inventory SET stock_quantity = stock_quantity + ? WHERE id = ?', [item.ordered_qty, item.inventory_id]);
        }
        await conn.execute('UPDATE purchase_orders SET status = "Received" WHERE id = ?', [req.params.id]);
        await conn.commit();
        res.json({ message: "Stock Added" });
    } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); } finally { conn.release(); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
