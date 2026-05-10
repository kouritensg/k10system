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
// 2. CATEGORY MANAGEMENT
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
// 4. INVENTORY
// ==========================================

// Public route (used by index.html) — unchanged
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

// Admin flat list (kept for backwards compat with other admin pages)
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

// Family list — groups inventory by set_name for the inventory landing page
app.get('/api/inventory/families', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        set_name,
        game_title,
        COUNT(*)            AS total_products,
        SUM(stock_quantity) AS total_stock,
        SUM(is_bundle)      AS bundle_count
      FROM inventory
      GROUP BY set_name, game_title
      ORDER BY game_title, set_name ASC`
    );
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch families' }); }
});

// Family detail — all products in a set_name with their bundle relationships
app.get('/api/inventory/family/:set_name', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        i.id,
        i.card_name,
        i.game_title,
        i.set_name,
        i.stock_quantity,
        i.price,
        i.cost_price,
        i.is_bundle,
        i.barcode,
        i.quick_description,
        i.category_id,
        c.name                    AS category_name,
        pb_up.parent_product_id   AS parent_id,
        pb_up.quantity_per_parent AS qty_in_parent
      FROM inventory i
      LEFT JOIN categories      c      ON c.id = i.category_id
      LEFT JOIN product_bundles pb_up  ON pb_up.child_product_id = i.id
      WHERE i.set_name = ?
      ORDER BY i.is_bundle DESC, i.id ASC
    `, [req.params.set_name]);

    const productIds = rows.map(r => r.id);
    if (productIds.length === 0) return res.json([]);

    const placeholders = productIds.map(() => '?').join(',');

    // Run children and waves queries in parallel using already-fetched IDs
    const [[children], [waves]] = await Promise.all([
      db.execute(`
        SELECT
          pb.parent_product_id,
          pb.child_product_id,
          pb.id AS bundle_id,
          pb.quantity_per_parent,
          i.card_name      AS child_name,
          i.stock_quantity AS child_stock
        FROM product_bundles pb
        JOIN inventory i ON i.id = pb.child_product_id
        WHERE pb.parent_product_id IN (${placeholders})
      `, productIds),
      db.execute(`
        SELECT id, inventory_id, wave_name, cost_price, remaining_qty
        FROM fifo
        WHERE is_active = TRUE AND remaining_qty > 0 AND inventory_id IN (${placeholders})
      `, productIds),
    ]);

    // Attach children array to each product
    const childMap = {};
    children.forEach(c => {
      if (!childMap[c.parent_product_id]) childMap[c.parent_product_id] = [];
      childMap[c.parent_product_id].push(c);
    });

    const waveMap = {};
    waves.forEach(w => {
      if (!waveMap[w.inventory_id]) waveMap[w.inventory_id] = [];
      waveMap[w.inventory_id].push(w);
    });

    const result = rows.map(r => ({
      ...r,
      children: childMap[r.id] || [],
      waves: waveMap[r.id] || []
    }));

    res.json(result);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch family' }); }
});

// Add new product — updated, removed packs_per_box/boxes_per_case, added set_name + is_bundle
app.post('/api/inventory/add', async (req, res) => {
  const {
    barcode, game_title, set_name, category_id, card_id, card_name,
    price, cost_price, stock_quantity, is_bundle, quick_description, long_description
  } = req.body;
  try {
    const [result] = await db.execute(
      `INSERT INTO inventory
        (barcode, game_title, set_name, category_id, card_id, card_name,
         price, cost_price, stock_quantity, is_bundle, quick_description, long_description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        barcode || null, game_title || null, set_name || '',
        category_id || null, card_id || null, card_name,
        price || 0, cost_price || 0, stock_quantity || 0,
        is_bundle || 0, quick_description || null, long_description || null
      ]
    );
    res.status(201).json({ id: result.insertId, message: 'Product registered!' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Update product — updated, added set_name + is_bundle + quick_description
app.put('/api/inventory/:id', async (req, res) => {
  const { price, stock_quantity, cost_price, category_id, set_name, is_bundle, quick_description } = req.body;
  try {
    await db.execute(
      `UPDATE inventory
       SET price = ?, stock_quantity = ?, cost_price = ?,
           category_id = ?, set_name = ?, is_bundle = ?, quick_description = ?
       WHERE id = ?`,
      [price, stock_quantity, cost_price || 0, category_id || null,
       set_name || '', is_bundle || 0, quick_description || null, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (error) { res.status(500).json({ error: 'Update failed' }); }
});

// Delete product
app.delete('/api/inventory/:id', async (req, res) => {
  try {
    await db.execute('DELETE FROM inventory WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (error) { res.status(500).json({ error: 'Delete failed' }); }
});

// ==========================================
// 4.5 FIFO WAVES
// ==========================================

app.get('/api/inventory/:id/waves', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM fifo WHERE inventory_id = ? AND is_active = TRUE ORDER BY arrival_date ASC, id ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch waves' }); }
});

async function syncInventoryStock(inventory_id, conn) {
  const [[result]] = await conn.execute(
    'SELECT SUM(remaining_qty) as total_stock, SUM(remaining_qty * cost_price) as total_value FROM fifo WHERE inventory_id = ? AND is_active = TRUE AND remaining_qty > 0',
    [inventory_id]
  );
  
  const totalStock = result.total_stock || 0;
  
  if (totalStock > 0) {
    const averageCost = result.total_value / totalStock;
    await conn.execute(
      'UPDATE inventory SET stock_quantity = ?, cost_price = ? WHERE id = ?',
      [totalStock, averageCost, inventory_id]
    );
  } else {
    await conn.execute(
      'UPDATE inventory SET stock_quantity = ? WHERE id = ?',
      [totalStock, inventory_id]
    );
  }
  
  return totalStock;
}

app.post('/api/inventory/:id/waves', async (req, res) => {
  const { wave_name, cost_price, initial_qty, arrival_date, invoice_number } = req.body;
  const inventory_id = req.params.id;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT INTO fifo (inventory_id, wave_name, cost_price, initial_qty, remaining_qty, arrival_date, is_active, invoice_number)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, ?)`,
      [inventory_id, wave_name || 'Standard', cost_price || 0, initial_qty || 0, initial_qty || 0, arrival_date || new Date().toISOString().slice(0,10), invoice_number || null]
    );
    const newTotal = await syncInventoryStock(inventory_id, conn);
    await conn.commit();
    res.status(201).json({ id: result.insertId, message: 'Wave added', total_stock: newTotal });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

app.put('/api/inventory/waves/:wave_id', async (req, res) => {
  const { wave_name, cost_price, remaining_qty, arrival_date, invoice_number } = req.body;
  const wave_id = req.params.wave_id;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[wave]] = await conn.execute('SELECT inventory_id FROM fifo WHERE id = ?', [wave_id]);
    if (!wave) throw new Error('Wave not found');

    await conn.execute(
      `UPDATE fifo SET wave_name = ?, cost_price = ?, remaining_qty = ?, arrival_date = ?, invoice_number = ?
       WHERE id = ?`,
      [wave_name, cost_price, remaining_qty, arrival_date, invoice_number || null, wave_id]
    );
    const newTotal = await syncInventoryStock(wave.inventory_id, conn);
    await conn.commit();
    res.json({ message: 'Wave updated', total_stock: newTotal });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

app.delete('/api/inventory/waves/:wave_id', async (req, res) => {
  const wave_id = req.params.wave_id;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[wave]] = await conn.execute('SELECT inventory_id FROM fifo WHERE id = ?', [wave_id]);
    if (!wave) throw new Error('Wave not found');

    await conn.execute('UPDATE fifo SET is_active = FALSE WHERE id = ?', [wave_id]);
    const newTotal = await syncInventoryStock(wave.inventory_id, conn);
    await conn.commit();
    res.json({ message: 'Wave removed', total_stock: newTotal });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

// ==========================================
// 5. BUNDLE MANAGEMENT
// ==========================================

// Get children of a product
app.get('/api/bundles/:product_id', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT pb.*, i.card_name AS child_name, i.stock_quantity AS child_stock
      FROM product_bundles pb
      JOIN inventory i ON i.id = pb.child_product_id
      WHERE pb.parent_product_id = ?
    `, [req.params.product_id]);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch bundle' }); }
});

// Add a child relationship
app.post('/api/bundles', async (req, res) => {
  const { parent_product_id, child_product_id, quantity_per_parent, notes } = req.body;
  try {
    await db.execute(
      `INSERT INTO product_bundles (parent_product_id, child_product_id, quantity_per_parent, notes)
       VALUES (?, ?, ?, ?)`,
      [parent_product_id, child_product_id, quantity_per_parent, notes || null]
    );
    // Mark parent as a bundle
    await db.execute('UPDATE inventory SET is_bundle = 1 WHERE id = ?', [parent_product_id]);
    res.status(201).json({ message: 'Bundle relationship added' });
  } catch (error) { res.status(500).json({ error: 'Failed — relationship may already exist' }); }
});

// Remove a child relationship
app.delete('/api/bundles/:id', async (req, res) => {
  try {
    const [[row]] = await db.execute(
      'SELECT parent_product_id FROM product_bundles WHERE id = ?', [req.params.id]
    );
    await db.execute('DELETE FROM product_bundles WHERE id = ?', [req.params.id]);

    // If no children left, unmark as bundle
    const [[count]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM product_bundles WHERE parent_product_id = ?', [row.parent_product_id]
    );
    if (count.cnt === 0) {
      await db.execute('UPDATE inventory SET is_bundle = 0 WHERE id = ?', [row.parent_product_id]);
    }
    res.json({ message: 'Relationship removed' });
  } catch (error) { res.status(500).json({ error: 'Failed to remove relationship' }); }
});

// Manual breakdown — one level at a time, transactional
app.post('/api/inventory/breakdown', async (req, res) => {
  const { parent_id, quantity, custom_costs } = req.body;

  if (!parent_id || !quantity || quantity < 1) {
    return res.status(400).json({ error: 'Invalid breakdown request' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Check parent has enough stock
    const [[parent]] = await conn.execute(
      'SELECT stock_quantity, card_name FROM inventory WHERE id = ?', [parent_id]
    );
    if (!parent) throw new Error('Product not found');
    if (parent.stock_quantity < quantity) {
      throw new Error(`Insufficient stock. Only ${parent.stock_quantity} unit(s) available`);
    }

    // 2. Get children
    const [children] = await conn.execute(
      'SELECT child_product_id, quantity_per_parent FROM product_bundles WHERE parent_product_id = ?',
      [parent_id]
    );
    if (children.length === 0) throw new Error('Product has no children configured for breakdown');

    // 3. Get active waves for parent
    const [parentWaves] = await conn.execute(
      'SELECT id, remaining_qty, cost_price, wave_name, arrival_date, invoice_number FROM fifo WHERE inventory_id = ? AND is_active = TRUE AND remaining_qty > 0 ORDER BY arrival_date ASC, id ASC',
      [parent_id]
    );

    let remainingToBreak = quantity;
    const waveDeductions = [];

    for (let wave of parentWaves) {
      if (remainingToBreak <= 0) break;
      
      let deductQty = Math.min(wave.remaining_qty, remainingToBreak);
      remainingToBreak -= deductQty;
      waveDeductions.push({
        wave_id: wave.id,
        cost_price: wave.cost_price,
        qty: deductQty,
        wave_name: wave.wave_name,
        arrival_date: wave.arrival_date,
        invoice_number: wave.invoice_number
      });
    }

    if (remainingToBreak > 0) {
      throw new Error('Not enough remaining quantity in active parent waves to break down this amount. Please verify wave stocks.');
    }

    // 4. Process deductions and generate child waves
    for (let deduction of waveDeductions) {
      // Deduct from parent wave
      await conn.execute(
        'UPDATE fifo SET remaining_qty = remaining_qty - ? WHERE id = ?',
        [deduction.qty, deduction.wave_id]
      );

      // Create child waves and log
      for (let child of children) {
        let childQtyToCreate = deduction.qty * child.quantity_per_parent;
        let childCostPrice = (parseFloat(deduction.cost_price) / child.quantity_per_parent).toFixed(2);
        
        if (custom_costs && custom_costs[child.child_product_id] !== undefined) {
          childCostPrice = parseFloat(custom_costs[child.child_product_id]).toFixed(2);
        }
        
        let newWaveName = `Breakdown from ${deduction.wave_name}`;
        
        // Check if an active child wave with the exact same name and invoice_number exists
        let queryStr = 'SELECT id, initial_qty, remaining_qty FROM fifo WHERE inventory_id = ? AND wave_name = ? AND is_active = TRUE';
        let queryParams = [child.child_product_id, newWaveName];
        
        if (deduction.invoice_number === null || deduction.invoice_number === undefined) {
           queryStr += ' AND invoice_number IS NULL';
        } else {
           queryStr += ' AND invoice_number = ?';
           queryParams.push(deduction.invoice_number);
        }
        queryStr += ' LIMIT 1';

        const [existingChildWave] = await conn.execute(queryStr, queryParams);

        let childWaveId;

        if (existingChildWave.length > 0) {
          // Update existing child wave
          childWaveId = existingChildWave[0].id;
          await conn.execute(
            'UPDATE fifo SET initial_qty = initial_qty + ?, remaining_qty = remaining_qty + ? WHERE id = ?',
            [childQtyToCreate, childQtyToCreate, childWaveId]
          );
        } else {
          // Insert new child wave
          const [childWaveResult] = await conn.execute(
            `INSERT INTO fifo (inventory_id, wave_name, cost_price, initial_qty, remaining_qty, arrival_date, is_active, invoice_number)
             VALUES (?, ?, ?, ?, ?, ?, TRUE, ?)`,
            [
              child.child_product_id, 
              newWaveName, 
              childCostPrice, 
              childQtyToCreate, 
              childQtyToCreate, 
              new Date().toISOString().slice(0, 10),
              deduction.invoice_number || null
            ]
          );
          childWaveId = childWaveResult.insertId;
        }

        // Log the breakdown with wave linkage
        await conn.execute(
          `INSERT INTO bundle_breakdown_log (parent_product_id, child_product_id, quantity_broken, parent_wave_id, child_wave_id)
           VALUES (?, ?, ?, ?, ?)`,
          [parent_id, child.child_product_id, deduction.qty, deduction.wave_id, childWaveId]
        );
      }
    }

    // 5. Sync total stocks
    await syncInventoryStock(parent_id, conn);
    for (let child of children) {
      await syncInventoryStock(child.child_product_id, conn);
    }

    await conn.commit();
    res.json({ message: `Successfully broke down ${quantity} × ${parent.card_name}` });

  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ==========================================
// 6. PURCHASING MODULE
// ==========================================
app.post('/api/purchase-orders', async (req, res) => {
  const { supplier_id, po_number, items, payment_status, total_cost, deposit_paid, paid_amount } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const orderDate = new Date().toISOString().slice(0, 10);
    const finalPONumber = po_number || `PO-${Date.now()}`;

    const [po] = await conn.execute(
      `INSERT INTO purchase_orders
        (supplier_id, po_number, order_date, status, payment_status, total_cost, deposit_paid, paid_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [supplier_id, finalPONumber, orderDate, 'Ordered', payment_status || 'Pending', total_cost || 0, deposit_paid || 0, paid_amount || 0]
    );

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
    console.error("PO Error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

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
        (SELECT SUM(poi.ordered_qty * poi.unit_cost) FROM po_items poi WHERE poi.po_id = po.id) as original_value
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      ORDER BY po.order_date DESC`
    );
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
    res.json({ message: 'Stock Updated' });
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

app.put('/api/purchase-orders/:id/payment', async (req, res) => {
  const { invoice_no, payment_date, amount_paid, final_total_cost } = req.body;
  try {
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

// ==========================================
// 7. SALES & PREORDERS
// ==========================================
app.post('/api/sales', async (req, res) => {
  const { customer_id, order_type, payment_method, items, custom_status, deposit_amount } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const total = items.reduce((sum, item) => sum + (item.qty * item.price), 0);
    const [orderResult] = await conn.execute(
      `INSERT INTO customer_orders (customer_id, order_type, status, total_amount, deposit_amount, payment_method)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [customer_id, order_type, custom_status || 'Paid', total, deposit_amount || 0, payment_method]
    );
    for (const item of items) {
      await conn.execute(
        'INSERT INTO customer_order_items (order_id, inventory_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
        [orderResult.insertId, item.id, item.qty, item.price]
      );
      if (order_type === 'In-Stock') {
        await conn.execute(
          'UPDATE inventory SET stock_quantity = stock_quantity - ? WHERE id = ?',
          [item.qty, item.id]
        );
      }
    }
    await conn.commit();
    res.status(201).json({ message: 'Order recorded!' });
  } catch (error) { await conn.rollback(); res.status(500).json({ error: error.message }); } finally { conn.release(); }
});

app.get('/api/sales/history', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT o.*, c.name as customer_name
      FROM customer_orders o
      JOIN customers c ON o.customer_id = c.id
      ORDER BY o.order_date DESC`
    );
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

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
      GROUP BY o.id ORDER BY o.order_date ASC`
    );
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/sales/:id/payment', async (req, res) => {
  const { amount } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      'SELECT total_amount, deposit_amount FROM customer_orders WHERE id = ?', [req.params.id]
    );
    const newTotalPaid = parseFloat(rows[0].deposit_amount || 0) + parseFloat(amount);
    const newStatus = newTotalPaid >= (parseFloat(rows[0].total_amount) - 0.01) ? 'Paid' : 'Partial';
    await conn.execute(
      'UPDATE customer_orders SET deposit_amount = ?, status = ? WHERE id = ?',
      [newTotalPaid, newStatus, req.params.id]
    );
    await conn.commit();
    res.json({ message: 'Payment recorded' });
  } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); } finally { conn.release(); }
});

// ==========================================
// 8. CUSTOMER MANAGEMENT
// ==========================================
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
  } catch (error) { res.status(500).json({ error: 'Failed to fetch customers' }); }
});

app.post('/api/customers', async (req, res) => {
  const { name, email, mobile_number, bandai_id, bushiroad_id } = req.body;
  try {
    const [result] = await db.execute(
      `INSERT INTO customers (name, email, mobile_number, bandai_id, bushiroad_id, status, loyalty_points)
       VALUES (?, ?, ?, ?, ?, 'Active', 0)`,
      [name, email || null, mobile_number || null, bandai_id || null, bushiroad_id || null]
    );
    res.status(201).json({ id: result.insertId, message: 'Customer created' });
  } catch (error) { res.status(500).json({ error: 'Database error or duplicate entry' }); }
});

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
  } catch (error) { res.status(500).json({ error: 'Failed to fetch history' }); }
});

app.delete('/api/customers/:id', async (req, res) => {
  try {
    await db.execute('DELETE FROM customers WHERE id = ?', [req.params.id]);
    res.json({ message: 'Customer deleted' });
  } catch (error) { res.status(500).json({ error: 'Cannot delete: Customer has existing orders.' }); }
});

// ==========================================
// KEEP ALIVE
// ==========================================
setInterval(async () => { try { await db.execute('SELECT 1'); } catch(e){} }, 300000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
