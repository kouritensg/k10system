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

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET || 'secret', { expiresIn: '12h' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) { res.status(500).json({ error: 'Login error' }); }
});

// Debug endpoint — returns what the server resolves from the current token
app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ resolved_user: req.user });
});

// --- AUTHENTICATE MIDDLEWARE (soft — enriches req.user, never blocks existing routes) ---
async function authenticate(req, res, next) {
  req.user = { username: 'unknown' };
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    let decoded;
    try { decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'secret'); }
    catch (e) { return next(); } // invalid token — stay as unknown, continue

    req.user = decoded;

    // Old tokens lack username — look it up from DB using the id
    if (!decoded.username && decoded.id) {
      try {
        const [[staff]] = await db.execute('SELECT username FROM staff WHERE id = ?', [decoded.id]);
        req.user.username = staff?.username || 'unknown';
      } catch (dbErr) {
        console.error('[auth] DB lookup failed:', dbErr.message);
        req.user.username = 'unknown';
      }
    }
    if (!req.user.username) req.user.username = 'unknown';
  }
  next();
}

// --- CHANGE LOG HELPER ---
async function logChange(conn, inventory_id, username, field_name, old_value, new_value, source) {
  const oldStr = old_value == null ? '' : String(old_value).trim();
  const newStr = new_value == null ? '' : String(new_value).trim();
  if (oldStr === newStr) return;
  await conn.execute(
    'INSERT INTO inventory_change_log (inventory_id, changed_by, field_name, old_value, new_value, source) VALUES (?, ?, ?, ?, ?, ?)',
    [inventory_id, username || 'unknown', field_name, old_value ?? null, new_value ?? null, source]
  );
}

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
      WHERE i.stock_quantity >= 0 AND i.product_type = 'sealed'
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
      WHERE i.product_type = 'sealed'
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
        i.set_name,
        i.game_title,
        c.name                                       AS category_name,
        COUNT(*)                                     AS category_count,
        SUM(i.stock_quantity)                        AS category_stock,
        SUM(i.is_bundle)                             AS category_bundles,
        SUM(i.stock_quantity * i.cost_price)         AS category_cost_value,
        SUM(i.stock_quantity * i.price)              AS category_retail_value
      FROM inventory i
      LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.product_type = 'sealed'
      GROUP BY i.set_name, i.game_title, i.category_id, c.name
      ORDER BY i.game_title, i.set_name, c.name ASC`
    );

    const familyMap = {};
    rows.forEach(row => {
      const key = `${row.set_name}|||${row.game_title}`;
      if (!familyMap[key]) {
        familyMap[key] = {
          set_name: row.set_name,
          game_title: row.game_title,
          total_products:    0,
          total_stock:       0,
          bundle_count:      0,
          total_cost_value:   0,
          total_retail_value: 0,
          categories: []
        };
      }
      const f = familyMap[key];
      f.total_products    += Number(row.category_count);
      f.total_stock       += Number(row.category_stock);
      f.bundle_count      += Number(row.category_bundles);
      f.total_cost_value  += Number(row.category_cost_value   || 0);
      f.total_retail_value+= Number(row.category_retail_value || 0);
      f.categories.push({ name: row.category_name || 'Uncategorized', stock: Number(row.category_stock) });
    });

    res.json(Object.values(familyMap));
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
      WHERE i.set_name = ? AND i.product_type = 'sealed'
      ORDER BY i.is_bundle DESC, i.id ASC
    `, [req.params.set_name]);

    const productIds = rows.map(r => r.id);
    if (productIds.length === 0) return res.json([]);

    const placeholders = productIds.map(() => '?').join(',');

    // Run children and waves queries in parallel using already-fetched IDs
    const [[children], [waves], [reservations]] = await Promise.all([
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
        SELECT f.id, f.inventory_id, f.wave_name, f.cost_price, f.remaining_qty, f.allocated_qty,
               f.parent_fifo_id, pf.wave_name AS parent_wave_name, pi.card_name AS parent_product_name
        FROM fifo f
        LEFT JOIN fifo pf ON pf.id = f.parent_fifo_id
        LEFT JOIN inventory pi ON pi.id = pf.inventory_id
        WHERE f.is_active = TRUE AND f.remaining_qty > 0 AND f.inventory_id IN (${placeholders})
      `, productIds),
      db.execute(`
        SELECT id, parent_product_id, reserved_qty, \`type\`, notes
        FROM inventory_reservations
        WHERE parent_product_id IN (${placeholders}) AND \`status\` = 'pending'
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

    const reservationMap = {};
    reservations.forEach(r => {
      if (!reservationMap[r.parent_product_id]) reservationMap[r.parent_product_id] = [];
      reservationMap[r.parent_product_id].push(r);
    });

    const result = rows.map(r => ({
      ...r,
      children: childMap[r.id] || [],
      waves: waveMap[r.id] || [],
      reservations: reservationMap[r.id] || []
    }));

    res.json(result);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch family' }); }
});

// ==========================================
// 4.1 SINGLES MANAGEMENT
// ==========================================

// Get all families (IP + set_name) across both sealed and singles inventory
app.get('/api/inventory/all-families', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        game_title,
        set_name,
        SUM(CASE WHEN product_type = 'single' THEN 1 ELSE 0 END) AS singles_count
      FROM inventory
      WHERE set_name IS NOT NULL AND set_name != ''
      GROUP BY game_title, set_name
      ORDER BY game_title, set_name
    `);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch families' }); }
});

// Get list of sets that have singles
app.get('/api/inventory/singles/sets', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT DISTINCT set_name, game_title
      FROM inventory
      WHERE product_type = 'single' AND set_name IS NOT NULL AND set_name != ''
      ORDER BY game_title, set_name
    `);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch singles sets' }); }
});

// Get all singles for a specific set
app.get('/api/inventory/singles', async (req, res) => {
  const { set } = req.query;
  try {
    let query = `
      SELECT id, card_id, card_name, game_title, set_name, 
             card_condition, card_finish, price, stock_quantity
      FROM inventory
      WHERE product_type = 'single'
    `;
    const params = [];
    if (set) {
      query += ' AND set_name = ?';
      params.push(set);
    }
    query += ' ORDER BY card_id, card_name';
    const [rows] = await db.execute(query, params);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch singles' }); }
});

// Add new product — updated, removed packs_per_box/boxes_per_case, added set_name + is_bundle + product_type
app.post('/api/inventory/add', async (req, res) => {
  const {
    barcode, game_title, set_name, category_id, card_id, card_name,
    price, cost_price, stock_quantity, is_bundle, quick_description, long_description,
    product_type, card_condition, card_finish
  } = req.body;
  try {
    const [result] = await db.execute(
      `INSERT INTO inventory
        (barcode, game_title, set_name, category_id, card_id, card_name,
         price, cost_price, stock_quantity, is_bundle, quick_description, long_description,
         product_type, card_condition, card_finish)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        barcode || null, game_title || null, set_name || '',
        category_id || null, card_id || null, card_name,
        price || 0, cost_price || 0, stock_quantity || 0,
        is_bundle || 0, quick_description || null, long_description || null,
        product_type || 'sealed', card_condition || null, card_finish || null
      ]
    );
    res.status(201).json({ id: result.insertId, message: 'Product registered!' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Update product — updated, added set_name + is_bundle + quick_description + long_description + card_id + card_name + product_type
app.put('/api/inventory/:id', authenticate, async (req, res) => {
  const { card_name, card_id, price, stock_quantity, cost_price, category_id, set_name, is_bundle, quick_description, long_description, product_type, card_condition, card_finish } = req.body;
  const conn = await db.getConnection();
  try {
    const [[old]] = await conn.execute('SELECT price FROM inventory WHERE id = ?', [req.params.id]);
    await conn.execute(
      `UPDATE inventory
       SET card_name = ?, card_id = ?, price = ?, stock_quantity = ?, cost_price = ?,
           category_id = ?, set_name = ?, is_bundle = ?, quick_description = ?, long_description = ?,
           product_type = ?, card_condition = ?, card_finish = ?
       WHERE id = ?`,
      [card_name || null, card_id || null, price, stock_quantity, cost_price || 0,
       category_id || null, set_name || '', is_bundle || 0,
       quick_description || null, long_description || null, 
       product_type || 'sealed', card_condition || null, card_finish || null, req.params.id]
    );
    await logChange(conn, req.params.id, req.user.username, 'price', old.price, price, 'Manual Edit');
    res.json({ message: 'Updated' });
  } catch (error) { res.status(500).json({ error: 'Update failed' }); }
  finally { conn.release(); }
});

// Delete product
app.delete('/api/inventory/:id', async (req, res) => {
  try {
    await db.execute('DELETE FROM inventory WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (error) { res.status(500).json({ error: 'Delete failed' }); }
});

// Change history for a product
app.get('/api/inventory/:id/history', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT id, field_name, old_value, new_value, source, changed_by, changed_at
       FROM inventory_change_log
       WHERE inventory_id = ?
       ORDER BY changed_at DESC
       LIMIT 50`,
      [req.params.id]
    );
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch history' }); }
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

async function syncInventoryStock(inventory_id, conn, username = 'system', source = 'System') {
  const [[old]] = await conn.execute(
    'SELECT stock_quantity, cost_price FROM inventory WHERE id = ?', [inventory_id]
  );
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
    await logChange(conn, inventory_id, username, 'stock_quantity', old.stock_quantity, totalStock, source);
    await logChange(conn, inventory_id, username, 'cost_price',     old.cost_price,     averageCost,  source);
  } else {
    await conn.execute(
      'UPDATE inventory SET stock_quantity = ? WHERE id = ?', [totalStock, inventory_id]
    );
    await logChange(conn, inventory_id, username, 'stock_quantity', old.stock_quantity, totalStock, source);
  }

  return totalStock;
}

app.post('/api/inventory/:id/waves', authenticate, async (req, res) => {
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
    const newTotal = await syncInventoryStock(inventory_id, conn, req.user.username, `${wave_name || 'Standard'} Created`);
    await conn.commit();
    res.status(201).json({ id: result.insertId, message: 'Wave added', total_stock: newTotal });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

app.put('/api/inventory/waves/:wave_id', authenticate, async (req, res) => {
  const { wave_name, cost_price, remaining_qty, arrival_date, invoice_number, allocated_qty } = req.body;
  const wave_id = req.params.wave_id;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[wave]] = await conn.execute(
      'SELECT inventory_id, wave_name, remaining_qty, allocated_qty, invoice_number, arrival_date FROM fifo WHERE id = ?', [wave_id]
    );
    if (!wave) throw new Error('Wave not found');

    const newAllocated = allocated_qty !== undefined ? Number(allocated_qty) : Number(wave.allocated_qty);
    if (newAllocated < 0 || newAllocated > Number(remaining_qty)) {
      throw new Error(`allocated_qty (${newAllocated}) must be between 0 and remaining_qty (${remaining_qty})`);
    }

    // Determine source label based on stock direction
    const oldQty = Number(wave.remaining_qty);
    const newQty = Number(remaining_qty);
    let source;
    if (newQty > oldQty)       source = `${wave_name} Restocked`;
    else if (newQty < oldQty)  source = `${wave_name} Stock Deducted`;
    else                        source = `${wave_name} Updated`;

    await conn.execute(
      `UPDATE fifo SET wave_name = ?, cost_price = ?, remaining_qty = ?, arrival_date = ?, invoice_number = ?, allocated_qty = ?
       WHERE id = ?`,
      [wave_name, cost_price, remaining_qty, arrival_date, invoice_number || null, newAllocated, wave_id]
    );

    // Log invoice_number and arrival_date changes
    await logChange(conn, wave.inventory_id, req.user.username, 'invoice_number',
      wave.invoice_number, invoice_number || null, source);
    await logChange(conn, wave.inventory_id, req.user.username, 'arrival_date',
      wave.arrival_date ? String(wave.arrival_date).slice(0, 10) : null,
      arrival_date || null, source);

    const newTotal = await syncInventoryStock(wave.inventory_id, conn, req.user.username, source);
    await conn.commit();
    res.json({ message: 'Wave updated', total_stock: newTotal });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

app.delete('/api/inventory/waves/:wave_id', authenticate, async (req, res) => {
  const wave_id = req.params.wave_id;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[wave]] = await conn.execute('SELECT inventory_id, wave_name FROM fifo WHERE id = ?', [wave_id]);
    if (!wave) throw new Error('Wave not found');

    await conn.execute('UPDATE fifo SET is_active = FALSE WHERE id = ?', [wave_id]);
    const newTotal = await syncInventoryStock(wave.inventory_id, conn, req.user.username, `${wave.wave_name} Removed`);
    await conn.commit();
    res.json({ message: 'Wave removed', total_stock: newTotal });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

// Split allocated_qty of a wave into a new named wave
app.post('/api/inventory/waves/:wave_id/split', authenticate, async (req, res) => {
  const { new_wave_name, split_qty } = req.body;
  const wave_id = req.params.wave_id;

  if (!new_wave_name || !new_wave_name.trim()) {
    return res.status(400).json({ error: 'new_wave_name is required' });
  }
  const qty = parseInt(split_qty);
  if (!qty || qty < 1) {
    return res.status(400).json({ error: 'split_qty must be >= 1' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[wave]] = await conn.execute(
      'SELECT inventory_id, wave_name, cost_price, remaining_qty, allocated_qty FROM fifo WHERE id = ? AND is_active = TRUE',
      [wave_id]
    );
    if (!wave) throw new Error('Wave not found');
    if (qty > Number(wave.allocated_qty)) {
      throw new Error(`split_qty (${qty}) exceeds allocated_qty (${wave.allocated_qty})`);
    }
    if (qty > Number(wave.remaining_qty)) {
      throw new Error(`split_qty (${qty}) exceeds remaining_qty (${wave.remaining_qty})`);
    }

    // Deduct from original wave
    await conn.execute(
      'UPDATE fifo SET remaining_qty = remaining_qty - ?, allocated_qty = allocated_qty - ? WHERE id = ?',
      [qty, qty, wave_id]
    );

    // Create new wave for the split stock
    const today = new Date().toISOString().slice(0, 10);
    const [result] = await conn.execute(
      `INSERT INTO fifo (inventory_id, wave_name, cost_price, initial_qty, remaining_qty, allocated_qty, arrival_date, is_active)
       VALUES (?, ?, ?, ?, ?, 0, ?, TRUE)`,
      [wave.inventory_id, new_wave_name.trim(), wave.cost_price, qty, qty, today]
    );

    // Sync — total stock unchanged but recalculate weighted cost
    await syncInventoryStock(wave.inventory_id, conn, req.user.username, `Wave Split: ${new_wave_name.trim()}`);
    await conn.commit();
    res.status(201).json({ original_wave_id: Number(wave_id), new_wave_id: result.insertId, new_wave_name: new_wave_name.trim() });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
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

// Shared breakdown logic — source product → one target product, one breakdown at a time
async function executeBreakdown(conn, source_id, source_qty, target_id, qty_per_source, target_cost_override) {
  if (source_id === target_id) throw new Error('Source and target must be different products');
  if (qty_per_source <= 0) throw new Error('Qty per source must be greater than 0');

  const [[source]] = await conn.execute(
    'SELECT stock_quantity, card_name FROM inventory WHERE id = ?', [source_id]
  );
  if (!source) throw new Error('Source product not found');
  if (source.stock_quantity < source_qty) {
    throw new Error(`Insufficient stock. Only ${source.stock_quantity} unit(s) available`);
  }

  const [[target]] = await conn.execute(
    'SELECT id, card_name FROM inventory WHERE id = ?', [target_id]
  );
  if (!target) throw new Error('Target product not found');

  const [sourceWaves] = await conn.execute(
    'SELECT id, remaining_qty, cost_price, wave_name, arrival_date, invoice_number FROM fifo WHERE inventory_id = ? AND is_active = TRUE AND remaining_qty > 0 ORDER BY arrival_date ASC, id ASC',
    [source_id]
  );

  let remainingToBreak = source_qty;
  const waveDeductions = [];

  for (const wave of sourceWaves) {
    if (remainingToBreak <= 0) break;
    const deductQty = Math.min(wave.remaining_qty, remainingToBreak);
    remainingToBreak -= deductQty;
    waveDeductions.push({
      wave_id: wave.id,
      cost_price: wave.cost_price,
      qty: deductQty,
      wave_name: wave.wave_name,
      invoice_number: wave.invoice_number
    });
  }

  if (remainingToBreak > 0) {
    throw new Error('Not enough stock in active waves to break down this amount.');
  }

  for (const deduction of waveDeductions) {
    await conn.execute(
      'UPDATE fifo SET remaining_qty = remaining_qty - ? WHERE id = ?',
      [deduction.qty, deduction.wave_id]
    );

    const targetQtyToCreate = deduction.qty * qty_per_source;
    const targetCost = target_cost_override != null
      ? parseFloat(target_cost_override).toFixed(2)
      : (parseFloat(deduction.cost_price) / qty_per_source).toFixed(2);
    const newWaveName = `Breakdown from ${deduction.wave_name}`;

    let queryStr = 'SELECT id FROM fifo WHERE inventory_id = ? AND wave_name = ? AND is_active = TRUE';
    const queryParams = [target_id, newWaveName];
    if (deduction.invoice_number == null) {
      queryStr += ' AND invoice_number IS NULL';
    } else {
      queryStr += ' AND invoice_number = ?';
      queryParams.push(deduction.invoice_number);
    }
    queryStr += ' LIMIT 1';

    const [existingWave] = await conn.execute(queryStr, queryParams);
    let targetWaveId;

    if (existingWave.length > 0) {
      targetWaveId = existingWave[0].id;
      await conn.execute(
        'UPDATE fifo SET initial_qty = initial_qty + ?, remaining_qty = remaining_qty + ? WHERE id = ?',
        [targetQtyToCreate, targetQtyToCreate, targetWaveId]
      );
    } else {
      const [insertResult] = await conn.execute(
        `INSERT INTO fifo (inventory_id, wave_name, cost_price, initial_qty, remaining_qty, arrival_date, is_active, invoice_number, parent_fifo_id)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, ?, ?)`,
        [
          target_id,
          newWaveName,
          targetCost,
          targetQtyToCreate,
          targetQtyToCreate,
          new Date().toISOString().slice(0, 10),
          deduction.invoice_number || null,
          deduction.wave_id
        ]
      );
      targetWaveId = insertResult.insertId;
    }

    await conn.execute(
      `INSERT INTO bundle_breakdown_log (parent_product_id, child_product_id, quantity_broken, parent_wave_id, child_wave_id)
       VALUES (?, ?, ?, ?, ?)`,
      [source_id, target_id, deduction.qty, deduction.wave_id, targetWaveId]
    );
  }

  await syncInventoryStock(source_id, conn);
  await syncInventoryStock(target_id, conn);

  return { message: `Broke down ${source_qty} × ${source.card_name} → ${source_qty * qty_per_source} × ${target.card_name}` };
}

// Manual breakdown — source → one target, transactional
app.post('/api/inventory/breakdown', async (req, res) => {
  const { source_id, source_qty, target_id, qty_per_source, target_cost } = req.body;
  if (!source_id || !target_id || !source_qty || source_qty < 1 || !qty_per_source || qty_per_source <= 0) {
    return res.status(400).json({ error: 'source_id, target_id, source_qty (≥1), and qty_per_source (>0) are required' });
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await executeBreakdown(conn, parseInt(source_id), parseInt(source_qty), parseInt(target_id), parseFloat(qty_per_source), target_cost ?? null);
    await conn.commit();
    res.json(result);
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ==========================================
// 5b. RESERVATION MODULE
// ==========================================

// Create or update a pending breakdown reservation
app.post('/api/inventory/breakdown/reserve', async (req, res) => {
  const { parent_id, quantity, type, notes } = req.body;
  if (!parent_id || !quantity || quantity < 1) {
    return res.status(400).json({ error: 'Invalid reservation request' });
  }
  if (type !== 'breakdown') {
    return res.status(400).json({ error: 'type must be "breakdown"' });
  }
  try {
    const [[parent]] = await db.execute(
      'SELECT stock_quantity, card_name, is_bundle FROM inventory WHERE id = ?', [parent_id]
    );
    if (!parent) return res.status(404).json({ error: 'Product not found' });
    if (type === 'breakdown' && !parent.is_bundle) {
      return res.status(400).json({ error: 'Only bundle products can have breakdown reservations' });
    }

    // Upsert: one pending reservation per (product, type)
    const [[existing]] = await db.execute(
      'SELECT id FROM inventory_reservations WHERE parent_product_id = ? AND `type` = ? AND `status` = \'pending\'',
      [parent_id, type]
    );

    if (existing) {
      await db.execute(
        'UPDATE inventory_reservations SET reserved_qty = ?, notes = ?, updated_at = NOW() WHERE id = ?',
        [quantity, notes || null, existing.id]
      );
      res.json({ id: existing.id, reserved_qty: quantity, message: `Reservation updated to ${quantity} unit(s)` });
    } else {
      const [result] = await db.execute(
        'INSERT INTO inventory_reservations (parent_product_id, reserved_qty, `type`, notes) VALUES (?, ?, ?, ?)',
        [parent_id, quantity, type, notes || null]
      );
      res.json({ id: result.insertId, reserved_qty: quantity, message: `Reserved ${quantity} unit(s) for ${type}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a pending reservation (soft delete)
app.delete('/api/inventory/breakdown/reserve/:id', async (req, res) => {
  try {
    const [[reservation]] = await db.execute(
      'SELECT id, `status` FROM inventory_reservations WHERE id = ?', [req.params.id]
    );
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    if (reservation.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending reservations can be cancelled' });
    }
    await db.execute(
      'UPDATE inventory_reservations SET status = \'cancelled\', updated_at = NOW() WHERE id = ?',
      [req.params.id]
    );
    res.json({ message: 'Reservation cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Commit a breakdown reservation — executes the actual breakdown
app.post('/api/inventory/breakdown/reserve/:id/commit', async (req, res) => {
  const { quantity, target_id, qty_per_source, target_cost } = req.body;
  if (!target_id || !qty_per_source || qty_per_source <= 0) {
    return res.status(400).json({ error: 'target_id and qty_per_source are required to commit a breakdown' });
  }
  const conn = await db.getConnection();
  try {
    const [[reservation]] = await conn.execute(
      'SELECT id, parent_product_id, reserved_qty, `type`, `status` FROM inventory_reservations WHERE id = ?',
      [req.params.id]
    );
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    if (reservation.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending reservations can be committed' });
    }
    if (reservation.type !== 'breakdown') {
      return res.status(400).json({ error: 'Only breakdown reservations can be committed' });
    }

    const qtyToBreak = quantity || reservation.reserved_qty;
    if (qtyToBreak > reservation.reserved_qty) {
      return res.status(400).json({ error: `Cannot commit more than the reserved quantity (${reservation.reserved_qty})` });
    }

    await conn.beginTransaction();
    const result = await executeBreakdown(conn, reservation.parent_product_id, qtyToBreak, parseInt(target_id), parseFloat(qty_per_source), target_cost ?? null);

    if (qtyToBreak >= reservation.reserved_qty) {
      await conn.execute(
        'UPDATE inventory_reservations SET status = \'committed\', updated_at = NOW() WHERE id = ?',
        [reservation.id]
      );
    } else {
      await conn.execute(
        'UPDATE inventory_reservations SET reserved_qty = reserved_qty - ?, updated_at = NOW() WHERE id = ?',
        [qtyToBreak, reservation.id]
      );
    }

    await conn.commit();
    res.json(result);
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ==========================================
// 5c. OUTSTOCK
// ==========================================

const VALID_ADJUSTMENT_REASONS = ['damage', 'loss', 'event', 'adjustment', 'return_to_supplier', 'giveaway', 'other'];

async function deductFifoWaves(conn, inventory_id, qty) {
  const [waves] = await conn.execute(
    `SELECT id, remaining_qty, wave_name
     FROM fifo
     WHERE inventory_id = ? AND is_active = TRUE AND remaining_qty > 0
     ORDER BY arrival_date ASC, id ASC`,
    [inventory_id]
  );

  let remaining = qty;
  const deductions = [];

  for (const wave of waves) {
    if (remaining <= 0) break;
    const take = Math.min(wave.remaining_qty, remaining);
    remaining -= take;
    deductions.push({ wave_id: wave.id, wave_name: wave.wave_name, qty: take });
  }

  if (remaining > 0) {
    throw new Error(`Insufficient stock. Requested ${qty} but only ${qty - remaining} available in active waves.`);
  }

  for (const d of deductions) {
    await conn.execute(
      'UPDATE fifo SET remaining_qty = remaining_qty - ? WHERE id = ?',
      [d.qty, d.wave_id]
    );
  }

  return deductions;
}

app.post('/api/outstock', authenticate, async (req, res) => {
  const { transaction_type, customer_id, transaction_date, notes, items } = req.body;

  if (!['sale', 'adjustment'].includes(transaction_type)) {
    return res.status(400).json({ error: 'transaction_type must be "sale" or "adjustment"' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }
  if (!transaction_date) {
    return res.status(400).json({ error: 'transaction_date is required' });
  }
  if (transaction_type === 'sale' && !customer_id) {
    return res.status(400).json({ error: 'customer_id is required for sales' });
  }

  for (const item of items) {
    if (!item.inventory_id || !item.qty || item.qty < 1) {
      return res.status(400).json({ error: 'Each item must have inventory_id and qty >= 1' });
    }
    if (transaction_type === 'sale' && (item.unit_price === undefined || item.unit_price === null)) {
      return res.status(400).json({ error: 'unit_price is required for sale items' });
    }
    if (transaction_type === 'adjustment') {
      if (!VALID_ADJUSTMENT_REASONS.includes(item.adjustment_reason)) {
        return res.status(400).json({ error: `Invalid adjustment_reason: ${item.adjustment_reason}` });
      }
      if (item.adjustment_reason === 'other' && (!item.notes || !item.notes.trim())) {
        return res.status(400).json({ error: 'notes are required when adjustment_reason is "other"' });
      }
    }
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    for (const item of items) {
      await deductFifoWaves(conn, item.inventory_id, item.qty);
      const source = transaction_type === 'sale' ? 'Sale' : item.adjustment_reason;
      await syncInventoryStock(item.inventory_id, conn, req.user.username, source);
    }

    const [txnResult] = await conn.execute(
      `INSERT INTO outstock_transactions (transaction_type, customer_id, transaction_date, notes, changed_by)
       VALUES (?, ?, ?, ?, ?)`,
      [transaction_type, customer_id || null, transaction_date, notes || null, req.user.username]
    );
    const txn_id = txnResult.insertId;

    for (const item of items) {
      await conn.execute(
        `INSERT INTO outstock_items (transaction_id, inventory_id, qty, unit_price, adjustment_reason, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          txn_id, item.inventory_id, item.qty,
          transaction_type === 'sale' ? item.unit_price : null,
          transaction_type === 'adjustment' ? item.adjustment_reason : null,
          item.notes || null
        ]
      );
    }

    await conn.commit();
    res.status(201).json({ id: txn_id, items_count: items.length, message: 'Transaction committed' });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.get('/api/outstock', async (req, res) => {
  const { transaction_type, customer_id, date_from, date_to, limit = 25, offset = 0 } = req.query;

  const where = ['ot.voided_at IS NULL'];
  const params = [];

  if (transaction_type) { where.push('ot.transaction_type = ?'); params.push(transaction_type); }
  if (customer_id)       { where.push('ot.customer_id = ?');      params.push(customer_id); }
  if (date_from)         { where.push('ot.transaction_date >= ?'); params.push(date_from); }
  if (date_to)           { where.push('ot.transaction_date <= ?'); params.push(date_to); }

  const whereClause = 'WHERE ' + where.join(' AND ');

  try {
    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM outstock_transactions ot ${whereClause}`,
      params
    );

    const [rows] = await db.execute(
      `SELECT
         ot.id, ot.transaction_type, ot.transaction_date, ot.notes,
         ot.changed_by, ot.created_at,
         c.name AS customer_name,
         COUNT(oi.id) AS items_count,
         SUM(oi.qty * COALESCE(oi.unit_price, 0)) AS total_value
       FROM outstock_transactions ot
       LEFT JOIN customers c ON c.id = ot.customer_id
       LEFT JOIN outstock_items oi ON oi.transaction_id = ot.id
       ${whereClause}
       GROUP BY ot.id
       ORDER BY ot.transaction_date DESC, ot.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    res.json({ rows, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/outstock/:id', async (req, res) => {
  try {
    const [[txn]] = await db.execute(
      `SELECT ot.*, c.name AS customer_name
       FROM outstock_transactions ot
       LEFT JOIN customers c ON c.id = ot.customer_id
       WHERE ot.id = ?`,
      [req.params.id]
    );
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    const [items] = await db.execute(
      `SELECT oi.*, i.card_name, i.set_name, i.game_title
       FROM outstock_items oi
       JOIN inventory i ON i.id = oi.inventory_id
       WHERE oi.transaction_id = ?`,
      [req.params.id]
    );

    res.json({ ...txn, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/outstock/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const conn = await db.getConnection();
  try {
    const [[txn]] = await conn.execute(
      'SELECT id, voided_at FROM outstock_transactions WHERE id = ?', [req.params.id]
    );
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.voided_at) return res.status(400).json({ error: 'Transaction already voided' });

    const [items] = await conn.execute(
      'SELECT inventory_id, qty FROM outstock_items WHERE transaction_id = ?', [req.params.id]
    );

    await conn.beginTransaction();

    const today = new Date().toISOString().slice(0, 10);
    for (const item of items) {
      await conn.execute(
        `INSERT INTO fifo (inventory_id, wave_name, cost_price, initial_qty, remaining_qty, arrival_date, is_active)
         VALUES (?, ?, 0, ?, ?, ?, TRUE)`,
        [item.inventory_id, `Outstock Void #${req.params.id}`, item.qty, item.qty, today]
      );
      await syncInventoryStock(item.inventory_id, conn, req.user.username, `Outstock Void #${req.params.id}`);
    }

    await conn.execute(
      'UPDATE outstock_transactions SET voided_at = NOW() WHERE id = ?', [req.params.id]
    );

    await conn.commit();
    res.json({ message: 'Transaction voided and stock restored' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
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

app.put('/api/purchase-orders/:id/receive', authenticate, async (req, res) => {
  const { items } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (let item of items) {
      const [[old]] = await conn.execute('SELECT stock_quantity FROM inventory WHERE id = ?', [item.inventory_id]);
      await conn.execute('UPDATE po_items SET received_qty = received_qty + ? WHERE id = ?', [item.qty_received, item.po_item_id]);
      await conn.execute('UPDATE inventory SET stock_quantity = stock_quantity + ? WHERE id = ?', [item.qty_received, item.inventory_id]);
      await logChange(conn, item.inventory_id, req.user.username, 'stock_quantity', old.stock_quantity, old.stock_quantity + item.qty_received, 'PO Received');
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
app.post('/api/sales', authenticate, async (req, res) => {
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
        const [[old]] = await conn.execute('SELECT stock_quantity FROM inventory WHERE id = ?', [item.id]);
        await conn.execute(
          'UPDATE inventory SET stock_quantity = stock_quantity - ? WHERE id = ?',
          [item.qty, item.id]
        );
        await logChange(conn, item.id, req.user.username, 'stock_quantity', old.stock_quantity, old.stock_quantity - item.qty, 'Sale');
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
