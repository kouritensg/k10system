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
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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
    const [users] = await db.execute('SELECT * FROM staff WHERE username = ? AND is_active = 1', [username]);
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

// --- HARD AUTH MIDDLEWARE (blocks with 401/403 — used for staff management routes) ---
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'secret');
    next();
  } catch (e) { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ==========================================
// 1b. STAFF MANAGEMENT
// ==========================================
app.get('/api/staff', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id, username, role, is_active, created_at FROM staff ORDER BY created_at ASC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch staff' }); }
});

app.post('/api/staff', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username?.trim()) return res.status(400).json({ error: 'Username is required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!['staff', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.execute('INSERT INTO staff (username, password_hash, role) VALUES (?, ?, ?)', [username.trim(), hash, role]);
    res.status(201).json({ id: result.insertId, message: 'Staff account created' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.put('/api/staff/:id', requireAuth, requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!['staff', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (String(req.user.id) === String(req.params.id) && role === 'staff')
    return res.status(400).json({ error: 'You cannot demote yourself' });
  try {
    await db.execute('UPDATE staff SET role = ? WHERE id = ?', [role, req.params.id]);
    res.json({ message: 'Role updated' });
  } catch (e) { res.status(500).json({ error: 'Failed to update role' }); }
});

app.patch('/api/staff/:id/toggle-active', requireAuth, requireAdmin, async (req, res) => {
  if (String(req.user.id) === String(req.params.id))
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  try {
    const [[staff]] = await db.execute('SELECT is_active FROM staff WHERE id = ?', [req.params.id]);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    const newState = staff.is_active ? 0 : 1;
    await db.execute('UPDATE staff SET is_active = ? WHERE id = ?', [newState, req.params.id]);
    res.json({ is_active: newState });
  } catch (e) { res.status(500).json({ error: 'Failed to toggle account' }); }
});

app.patch('/api/staff/:id/password', requireAuth, requireAdmin, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(new_password, 10);
    const [r] = await db.execute('UPDATE staff SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Staff not found' });
    res.json({ message: 'Password updated' });
  } catch (e) { res.status(500).json({ error: 'Failed to update password' }); }
});

app.patch('/api/auth/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password || new_password.length < 6)
    return res.status(400).json({ error: 'Provide current and new password (min 6 chars)' });
  try {
    const [[user]] = await db.execute('SELECT password_hash FROM staff WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!await bcrypt.compare(current_password, user.password_hash))
      return res.status(400).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 10);
    await db.execute('UPDATE staff SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (e) { res.status(500).json({ error: 'Failed to change password' }); }
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
// Per-family categories — READ ONLY. Category structure (name/tier/qty) is owned by per-IP
// configurations and seeded at family-create / apply-configs (see product_configs + the
// seedFamilyCategories helper). Manual category CRUD was retired with the Categories page.
// GET ?family_id=X returns only that family's categories; no param returns all.
app.get('/api/categories', async (req, res) => {
  const { family_id } = req.query;
  try {
    let query = 'SELECT * FROM categories';
    const params = [];
    if (family_id) {
      query += ' WHERE family_id = ?';
      params.push(family_id);
    }
    query += ' ORDER BY COALESCE(tier, 999) ASC, name ASC';
    const [rows] = await db.execute(query, params);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch categories' }); }
});

// ==========================================
// 2.5 GAMES MANAGEMENT
// ==========================================
app.get('/api/games', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM games WHERE archived = 0 ORDER BY sort_order ASC, name ASC');
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch games' }); }
});

app.post('/api/games', async (req, res) => {
  const { name, display_label, sort_order } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO games (name, display_label, sort_order) VALUES (?, ?, ?)',
      [name.trim(), display_label?.trim() || null, sort_order || 0]
    );
    // Every IP starts with the default singles Condition/Finishing values (editable in IP & Config).
    await seedDefaultSinglesConfig(conn, result.insertId);
    await conn.commit();
    res.status(201).json({ id: result.insertId, message: 'Game created' });
  } catch (error) {
    await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Game name already exists' });
    res.status(500).json({ error: 'Failed to create game' });
  } finally { conn.release(); }
});

// Must be registered before PATCH /api/games/:id — bulk reorder games
app.patch('/api/games/reorder', authenticate, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (const item of items) {
      await conn.execute('UPDATE games SET sort_order = ? WHERE id = ?', [item.sort_order, item.id]);
    }
    await conn.commit();
    res.json({ message: 'Game order updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

app.patch('/api/games/:id', async (req, res) => {
  const { name, display_label, sort_order } = req.body;
  try {
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
    if (display_label !== undefined) { updates.push('display_label = ?'); params.push(display_label?.trim() || null); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const [result] = await db.execute(`UPDATE games SET ${updates.join(', ')} WHERE id = ?`, params);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Game not found' });
    res.json({ message: 'Game updated' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Game name already exists' });
    res.status(500).json({ error: 'Failed to update game' });
  }
});

app.delete('/api/games/:id', async (req, res) => {
  try {
    const [[inUse]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM inventory_families WHERE game_id = ?', [req.params.id]
    );
    if (inUse.cnt > 0) {
      return res.status(409).json({ error: 'Game has existing families — archive it instead.', can_archive: true });
    }
    await db.execute('DELETE FROM games WHERE id = ?', [req.params.id]);
    res.json({ message: 'Game deleted' });
  } catch (error) { res.status(500).json({ error: 'Failed to delete game' }); }
});

app.patch('/api/games/:id/archive', async (req, res) => {
  try {
    const [[game]] = await db.execute('SELECT archived FROM games WHERE id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const newState = game.archived ? 0 : 1;
    await db.execute('UPDATE games SET archived = ? WHERE id = ?', [newState, req.params.id]);
    res.json({ archived: newState, message: newState ? 'Game archived' : 'Game restored' });
  } catch (error) { res.status(500).json({ error: 'Failed to toggle archive' }); }
});

// ==========================================
// 2.6 LINE-UPS MANAGEMENT
// Departments within an IP (TCG, Accessories, Snacks...). Cross-cutting:
// one line-up spans many IPs (via line_up_games), one IP has many line-ups.
// ==========================================
app.get('/api/line-ups', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM line_ups WHERE archived = 0 ORDER BY sort_order ASC, name ASC');
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch line-ups' }); }
});

app.post('/api/line-ups', async (req, res) => {
  const { name, display_label, sort_order, uses_families } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const [result] = await db.execute(
      'INSERT INTO line_ups (name, display_label, sort_order, uses_families) VALUES (?, ?, ?, ?)',
      [name.trim(), display_label?.trim() || null, sort_order || 0,
       uses_families === undefined ? 1 : (uses_families ? 1 : 0)]
    );
    res.status(201).json({ id: result.insertId, message: 'Line-up created' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Line-up name already exists' });
    res.status(500).json({ error: 'Failed to create line-up' });
  }
});

// Must be registered before PATCH /api/line-ups/:id — bulk reorder
app.patch('/api/line-ups/reorder', authenticate, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (const item of items) {
      await conn.execute('UPDATE line_ups SET sort_order = ? WHERE id = ?', [item.sort_order, item.id]);
    }
    await conn.commit();
    res.json({ message: 'Line-up order updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

app.patch('/api/line-ups/:id', async (req, res) => {
  const { name, display_label, sort_order, uses_families } = req.body;
  try {
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
    if (display_label !== undefined) { updates.push('display_label = ?'); params.push(display_label?.trim() || null); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }
    if (uses_families !== undefined) { updates.push('uses_families = ?'); params.push(uses_families ? 1 : 0); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const [result] = await db.execute(`UPDATE line_ups SET ${updates.join(', ')} WHERE id = ?`, params);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Line-up not found' });
    res.json({ message: 'Line-up updated' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Line-up name already exists' });
    res.status(500).json({ error: 'Failed to update line-up' });
  }
});

app.delete('/api/line-ups/:id', async (req, res) => {
  try {
    const [[inUse]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM inventory_families WHERE line_up_id = ?', [req.params.id]
    );
    if (inUse.cnt > 0) {
      return res.status(409).json({ error: 'Line-up has families assigned — archive it instead.', can_archive: true });
    }
    await db.execute('DELETE FROM line_ups WHERE id = ?', [req.params.id]);
    res.json({ message: 'Line-up deleted' });
  } catch (error) { res.status(500).json({ error: 'Failed to delete line-up' }); }
});

app.patch('/api/line-ups/:id/archive', async (req, res) => {
  try {
    const [[lu]] = await db.execute('SELECT archived FROM line_ups WHERE id = ?', [req.params.id]);
    if (!lu) return res.status(404).json({ error: 'Line-up not found' });
    const newState = lu.archived ? 0 : 1;
    await db.execute('UPDATE line_ups SET archived = ? WHERE id = ?', [newState, req.params.id]);
    res.json({ archived: newState, message: newState ? 'Line-up archived' : 'Line-up restored' });
  } catch (error) { res.status(500).json({ error: 'Failed to toggle archive' }); }
});

// Read the IPs assigned to a line-up
app.get('/api/line-ups/:id/games', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT game_id FROM line_up_games WHERE line_up_id = ?', [req.params.id]);
    res.json(rows.map(r => r.game_id));
  } catch (error) { res.status(500).json({ error: 'Failed to fetch line-up IPs' }); }
});

// Replace the IP assignment set for a line-up (the "assign IPs" step)
app.put('/api/line-ups/:id/games', authenticate, async (req, res) => {
  const { game_ids } = req.body;
  if (!Array.isArray(game_ids)) return res.status(400).json({ error: 'game_ids array required' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM line_up_games WHERE line_up_id = ?', [req.params.id]);
    for (const gid of game_ids) {
      await conn.execute('INSERT INTO line_up_games (line_up_id, game_id) VALUES (?, ?)', [req.params.id, gid]);
    }
    await conn.commit();
    res.json({ message: 'Line-up IPs updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ---- IP-keyed line-up assignment (mirror of the two handlers above, keyed by game) ----
// Read the line-ups carried by an IP
app.get('/api/games/:gameId/line-ups', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT line_up_id FROM line_up_games WHERE game_id = ?', [req.params.gameId]);
    res.json(rows.map(r => r.line_up_id));
  } catch (error) { res.status(500).json({ error: 'Failed to fetch IP line-ups' }); }
});

// Replace the line-up set carried by an IP (the IP-first "which line-ups does this IP carry" step)
app.put('/api/games/:gameId/line-ups', authenticate, async (req, res) => {
  const { line_up_ids } = req.body;
  if (!Array.isArray(line_up_ids)) return res.status(400).json({ error: 'line_up_ids array required' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM line_up_games WHERE game_id = ?', [req.params.gameId]);
    for (const lid of line_up_ids) {
      await conn.execute('INSERT INTO line_up_games (line_up_id, game_id) VALUES (?, ?)', [lid, req.params.gameId]);
    }
    await conn.commit();
    res.json({ message: 'IP line-ups updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ==========================================
// 2.7 PER-IP CASE/PACK CONFIGURATIONS
// A config is a named breakdown template scoped to one IP (game): an ordered tier
// ladder (container -> ... -> pack). Configs SEED per-family `categories` at
// family-create time (see POST /api/inventory/families); they never change FIFO,
// product_bundles, or already-seeded categories. Config + its tiers move together.
// ==========================================

// Validate + normalise a tiers array from the request body. `startTier` is the absolute tier of the
// top row (default 1) so a config can sit below the top of the global ladder, e.g. TIN(T2)→Pack(T3).
// Returns { error } or { tiers }.
function normaliseConfigTiers(tiers, startTier) {
  const start = (startTier === undefined || startTier === null) ? 1 : startTier;
  if (!Number.isInteger(start) || start < 1) {
    return { error: 'Starting tier must be a positive integer' };
  }
  if (!Array.isArray(tiers) || tiers.length < 2) {
    return { error: 'A configuration needs at least 2 tiers (a container and a child)' };
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i] || {};
    const name = (t.category_name || '').trim();
    if (!name) return { error: `Tier ${i + 1} needs a category name` };
    const key = name.toLowerCase();
    if (seen.has(key)) return { error: `Duplicate category name "${name}" within the configuration` };
    seen.add(key);
    let qty;
    if (i === 0) {
      qty = null; // top container of this config has no parent within it
    } else {
      qty = t.qty_per_parent;
      if (!Number.isInteger(qty) || qty <= 0) {
        return { error: `Tier ${i + 1} ("${name}") needs a positive quantity per parent` };
      }
    }
    out.push({ tier: start + i, category_name: name, qty_per_parent: qty });
  }
  return { tiers: out };
}

// List an IP's configs, each with its ordered tiers (no N+1: two queries stitched in JS)
app.get('/api/games/:gameId/configs', async (req, res) => {
  const includeArchived = req.query.include_archived === '1';
  try {
    const [configs] = await db.execute(
      `SELECT id, game_id, name, display_label, sort_order, archived
         FROM product_configs
        WHERE game_id = ? ${includeArchived ? '' : 'AND archived = 0'}
        ORDER BY sort_order ASC, id ASC`,
      [req.params.gameId]
    );
    if (!configs.length) return res.json([]);
    const ids = configs.map(c => c.id);
    const [tiers] = await db.query(
      'SELECT config_id, tier, category_name, qty_per_parent FROM product_config_tiers WHERE config_id IN (?) ORDER BY tier ASC',
      [ids]
    );
    const byConfig = {};
    for (const t of tiers) (byConfig[t.config_id] ||= []).push(t);
    res.json(configs.map(c => ({ ...c, tiers: byConfig[c.id] || [] })));
  } catch (error) { res.status(500).json({ error: 'Failed to fetch configurations' }); }
});

// Create a config + its tier ladder in one transaction
app.post('/api/games/:gameId/configs', async (req, res) => {
  const { name, display_label, sort_order, tiers, start_tier } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const norm = normaliseConfigTiers(tiers, start_tier);
  if (norm.error) return res.status(400).json({ error: norm.error });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO product_configs (game_id, name, display_label, sort_order) VALUES (?, ?, ?, ?)',
      [req.params.gameId, name.trim(), display_label?.trim() || null, sort_order || 0]
    );
    const configId = result.insertId;
    for (const t of norm.tiers) {
      await conn.execute(
        'INSERT INTO product_config_tiers (config_id, tier, category_name, qty_per_parent) VALUES (?, ?, ?, ?)',
        [configId, t.tier, t.category_name, t.qty_per_parent]
      );
    }
    await conn.commit();
    res.status(201).json({ id: configId, message: 'Configuration created' });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A configuration with that name already exists for this IP' });
    res.status(500).json({ error: 'Failed to create configuration' });
  } finally { conn.release(); }
});

// Edit a config: name/label/sort_order and/or a full tier-ladder replace. Forward-only —
// never touches already-seeded `categories`/`product_bundles`.
app.patch('/api/games/:gameId/configs/:id', async (req, res) => {
  const { name, display_label, sort_order, tiers, start_tier } = req.body;
  let normTiers = null;
  if (tiers !== undefined) {
    const norm = normaliseConfigTiers(tiers, start_tier);
    if (norm.error) return res.status(400).json({ error: norm.error });
    normTiers = norm.tiers;
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const updates = [];
    const params = [];
    if (name !== undefined) {
      if (!name.trim()) { await conn.rollback(); return res.status(400).json({ error: 'Name cannot be empty' }); }
      updates.push('name = ?'); params.push(name.trim());
    }
    if (display_label !== undefined) { updates.push('display_label = ?'); params.push(display_label?.trim() || null); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }
    if (updates.length) {
      params.push(req.params.id, req.params.gameId);
      const [result] = await conn.execute(
        `UPDATE product_configs SET ${updates.join(', ')} WHERE id = ? AND game_id = ?`, params
      );
      if (result.affectedRows === 0) { await conn.rollback(); return res.status(404).json({ error: 'Configuration not found' }); }
    } else {
      // no scalar updates — still confirm the config belongs to this IP before replacing tiers
      const [[cfg]] = await conn.execute(
        'SELECT id FROM product_configs WHERE id = ? AND game_id = ?', [req.params.id, req.params.gameId]
      );
      if (!cfg) { await conn.rollback(); return res.status(404).json({ error: 'Configuration not found' }); }
    }
    if (normTiers) {
      await conn.execute('DELETE FROM product_config_tiers WHERE config_id = ?', [req.params.id]);
      for (const t of normTiers) {
        await conn.execute(
          'INSERT INTO product_config_tiers (config_id, tier, category_name, qty_per_parent) VALUES (?, ?, ?, ?)',
          [req.params.id, t.tier, t.category_name, t.qty_per_parent]
        );
      }
    }
    await conn.commit();
    res.json({ message: 'Configuration updated' });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A configuration with that name already exists for this IP' });
    res.status(500).json({ error: 'Failed to update configuration' });
  } finally { conn.release(); }
});

// Archive a config (hide from the seed picker + Stage-2 list)
app.patch('/api/games/:gameId/configs/:id/archive', async (req, res) => {
  try {
    const [[cfg]] = await db.execute(
      'SELECT archived FROM product_configs WHERE id = ? AND game_id = ?', [req.params.id, req.params.gameId]
    );
    if (!cfg) return res.status(404).json({ error: 'Configuration not found' });
    const newState = cfg.archived ? 0 : 1;
    await db.execute('UPDATE product_configs SET archived = ? WHERE id = ?', [newState, req.params.id]);
    res.json({ archived: newState, message: newState ? 'Configuration archived' : 'Configuration restored' });
  } catch (error) { res.status(500).json({ error: 'Failed to toggle archive' }); }
});

// Hard delete a config (cascade drops its tiers). Safe — configs don't hard-link families after seeding.
app.delete('/api/games/:gameId/configs/:id', async (req, res) => {
  try {
    const [result] = await db.execute(
      'DELETE FROM product_configs WHERE id = ? AND game_id = ?', [req.params.id, req.params.gameId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Configuration not found' });
    res.json({ message: 'Configuration deleted' });
  } catch (error) { res.status(500).json({ error: 'Failed to delete configuration' }); }
});

// ==========================================
// 2.8 PER-IP SINGLES CONFIGURATION
// One value-set per IP (game): allowed Rarity / Condition / Finishing values for single cards.
// The single source of truth for the singles-manager dropdowns (no hardcoded fallback there).
// Condition/Finishing are seeded with defaults per IP; Rarity is game-specific (starts empty).
// ==========================================
const SINGLES_DIMENSIONS = ['rarity', 'condition', 'finish'];
const SINGLES_DEFAULTS = {
  condition: ['NM', 'LP', 'MP', 'HP', 'DMG'],
  finish:    ['Foil', 'Reverse', 'Alt Art']
};

// Seed the default Condition/Finishing values for an IP (idempotent via uk_singles_cfg). Rarity omitted.
async function seedDefaultSinglesConfig(conn, gameId) {
  for (const dim of ['condition', 'finish']) {
    let i = 0;
    for (const value of SINGLES_DEFAULTS[dim]) {
      await conn.execute(
        'INSERT IGNORE INTO singles_config_values (game_id, dimension, value, sort_order) VALUES (?, ?, ?, ?)',
        [gameId, dim, value, i++]
      );
    }
  }
}

// Normalise one dimension's incoming list into [{ value, label }]. Returns { error } or { items }.
function normaliseSinglesValues(dim, raw) {
  if (raw === undefined || raw === null) return { items: [] };
  if (!Array.isArray(raw)) return { error: `${dim} must be an array` };
  const seen = new Set();
  const items = [];
  for (const entry of raw) {
    const value = (typeof entry === 'string' ? entry : (entry && entry.value) || '').trim();
    if (!value) return { error: `${dim} values cannot be blank` };
    const key = value.toLowerCase();
    if (seen.has(key)) return { error: `Duplicate ${dim} value "${value}"` };
    seen.add(key);
    const label = (entry && typeof entry === 'object' && entry.label) ? String(entry.label).trim() : null;
    items.push({ value, label: label || null });
  }
  return { items };
}

// Read an IP's singles config, grouped by dimension.
app.get('/api/games/:gameId/singles-config', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT dimension, value, label FROM singles_config_values
        WHERE game_id = ? ORDER BY sort_order ASC, id ASC`,
      [req.params.gameId]
    );
    const out = { rarity: [], condition: [], finish: [] };
    for (const r of rows) (out[r.dimension] ||= []).push({ value: r.value, label: r.label });
    res.json(out);
  } catch (error) { res.status(500).json({ error: error.message || 'Failed to fetch singles configuration' }); }
});

// Replace an IP's singles config (all three dimensions at once).
app.put('/api/games/:gameId/singles-config', async (req, res) => {
  const normalised = {};
  for (const dim of SINGLES_DIMENSIONS) {
    const norm = normaliseSinglesValues(dim, req.body[dim]);
    if (norm.error) return res.status(400).json({ error: norm.error });
    normalised[dim] = norm.items;
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM singles_config_values WHERE game_id = ?', [req.params.gameId]);
    for (const dim of SINGLES_DIMENSIONS) {
      let i = 0;
      for (const item of normalised[dim]) {
        await conn.execute(
          'INSERT INTO singles_config_values (game_id, dimension, value, label, sort_order) VALUES (?, ?, ?, ?, ?)',
          [req.params.gameId, dim, item.value, item.label, i++]
        );
      }
    }
    await conn.commit();
    res.json({ message: 'Singles configuration saved' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message || 'Failed to save singles configuration' });
  } finally { conn.release(); }
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

// Latest family per game — for the All tab overview
app.get('/api/inventory/latest-by-game', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        g.id                                                          AS game_id,
        g.name                                                        AS game_name,
        g.display_label,
        g.sort_order,
        (SELECT f.id FROM inventory_families f
         WHERE f.game_id = g.id AND f.is_container = 0
         ORDER BY COALESCE(f.release_date, '1900-01-01') DESC, f.id DESC
         LIMIT 1)                                                     AS latest_family_id,
        (SELECT f.set_code FROM inventory_families f
         WHERE f.game_id = g.id AND f.is_container = 0
         ORDER BY COALESCE(f.release_date, '1900-01-01') DESC, f.id DESC
         LIMIT 1)                                                     AS latest_set_code,
        (SELECT f.set_name FROM inventory_families f
         WHERE f.game_id = g.id AND f.is_container = 0
         ORDER BY COALESCE(f.release_date, '1900-01-01') DESC, f.id DESC
         LIMIT 1)                                                     AS latest_set_name,
        (SELECT f.release_date FROM inventory_families f
         WHERE f.game_id = g.id AND f.is_container = 0
         ORDER BY COALESCE(f.release_date, '1900-01-01') DESC, f.id DESC
         LIMIT 1)                                                     AS latest_release_date,
        COALESCE(SUM(i.stock_quantity), 0)                           AS total_stock,
        COALESCE(SUM(i.stock_quantity * i.cost_price), 0)            AS total_cost_value,
        COALESCE(SUM(i.stock_quantity * i.price), 0)                 AS total_retail_value
      FROM games g
      LEFT JOIN inventory_families gf ON gf.game_id = g.id AND gf.is_container = 0
      LEFT JOIN inventory i ON i.family_id = gf.id AND i.product_type <> 'single'
      WHERE g.archived = 0
      GROUP BY g.id
      ORDER BY g.sort_order ASC`
    );
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch latest by game' }); }
});

// IP -> line-up summary for the landing page (Stages 1 & 2).
// Returns each non-archived game with the line-ups assigned to it via line_up_games,
// LEFT-joined to families/inventory so an assigned-but-empty line-up still shows.
app.get('/api/inventory/ip-lineup-summary', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        g.id            AS game_id,
        g.name          AS game_name,
        g.display_label AS game_display,
        g.sort_order    AS game_sort,
        lu.id           AS line_up_id,
        lu.name         AS line_up_name,
        lu.display_label AS line_up_display,
        lu.icon         AS line_up_icon,
        lu.sort_order   AS line_up_sort,
        lu.uses_families AS uses_families,
        COUNT(DISTINCT f.id)               AS family_count,
        COUNT(DISTINCT CASE WHEN i.product_type = 'single' THEN i.id END) AS singles_count,
        COALESCE(SUM(i.stock_quantity), 0) AS total_stock
      FROM line_up_games lug
      JOIN games    g  ON g.id  = lug.game_id    AND g.archived  = 0
      JOIN line_ups lu ON lu.id = lug.line_up_id AND lu.archived = 0
      LEFT JOIN inventory_families f ON f.game_id = g.id AND f.line_up_id = lu.id
      LEFT JOIN inventory i          ON i.family_id = f.id
      GROUP BY g.id, lu.id
      ORDER BY g.sort_order ASC, lu.sort_order ASC`
    );
    const gameMap = {};
    rows.forEach(r => {
      if (!gameMap[r.game_id]) {
        gameMap[r.game_id] = {
          game_id:       r.game_id,
          game_name:     r.game_name,
          display_label: r.game_display,
          sort_order:    r.game_sort,
          line_ups:      []
        };
      }
      gameMap[r.game_id].line_ups.push({
        line_up_id:    r.line_up_id,
        name:          r.line_up_name,
        display_label: r.line_up_display,
        icon:          r.line_up_icon,
        uses_families: !!r.uses_families,
        family_count:  Number(r.family_count),
        singles_count: Number(r.singles_count) || 0,
        total_stock:   Number(r.total_stock)
      });
    });
    res.json(Object.values(gameMap));
  } catch (error) { res.status(500).json({ error: 'Failed to fetch IP/line-up summary' }); }
});

// Find-or-create the hidden container family for a flat (no-family) line-up.
// One container per (game, line_up); never shown as a card. Lets flat line-ups
// reuse the whole family/FIFO/product machinery.
app.post('/api/inventory/flat-family', authenticate, async (req, res) => {
  const { game_id, line_up_id } = req.body;
  if (!game_id || !line_up_id) return res.status(400).json({ error: 'game_id and line_up_id are required' });
  const conn = await db.getConnection();
  try {
    const [[existing]] = await conn.execute(
      'SELECT id FROM inventory_families WHERE game_id = ? AND line_up_id = ? AND is_container = 1 LIMIT 1',
      [game_id, line_up_id]
    );
    if (existing) return res.json({ family_id: existing.id });

    const [[lu]] = await conn.execute('SELECT name, display_label FROM line_ups WHERE id = ?', [line_up_id]);
    if (!lu) return res.status(400).json({ error: 'line_up_id does not match a line-up' });
    const setName = lu.display_label || lu.name;
    const setCode = `__LU${line_up_id}_G${game_id}`;
    const [result] = await conn.execute(
      'INSERT INTO inventory_families (game_id, line_up_id, is_container, set_code, set_name) VALUES (?, ?, 1, ?, ?)',
      [game_id, line_up_id, setCode, setName]
    );
    res.status(201).json({ family_id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to resolve flat line-up family' });
  } finally { conn.release(); }
});

// Family list — grouped by inventory_families for the inventory grid
app.get('/api/inventory/families', async (req, res) => {
  try {
    // Container families (flat line-ups) never show as cards. Optional line-up filter too.
    const lineUpId = req.query.line_up_id ? parseInt(req.query.line_up_id, 10) : null;
    const lineUpFilter = lineUpId ? 'WHERE f.is_container = 0 AND f.line_up_id = ?' : 'WHERE f.is_container = 0';
    const lineUpParams = lineUpId ? [lineUpId] : [];

    // Families from the inventory_families table
    const [rows] = await db.execute(`
      SELECT
        f.id,
        f.set_code,
        f.set_name                                        AS family_set_name,
        f.release_date,
        f.sort_order                                      AS family_sort_order,
        f.line_up_id,
        lu.name                                           AS line_up_name,
        (SELECT COUNT(*) FROM inventory s
          WHERE s.family_id = f.id AND s.product_type = 'single') AS singles_count,
        g.id                                              AS game_id,
        g.name                                            AS game_title,
        g.display_label,
        c.name                                            AS category_name,
        COUNT(i.id)                                       AS category_count,
        COALESCE(SUM(i.stock_quantity), 0)                AS category_stock,
        COALESCE(SUM(i.is_bundle), 0)                     AS category_bundles,
        COALESCE(SUM(i.stock_quantity * i.cost_price), 0) AS category_cost_value,
        COALESCE(SUM(i.stock_quantity * i.price), 0)      AS category_retail_value
      FROM inventory_families f
      JOIN games g ON g.id = f.game_id AND g.archived = 0
      LEFT JOIN line_ups lu ON lu.id = f.line_up_id
      LEFT JOIN inventory i ON i.family_id = f.id AND i.product_type <> 'single'
      LEFT JOIN categories c ON c.id = i.category_id
      ${lineUpFilter}
      GROUP BY f.id, c.id
      ORDER BY g.sort_order ASC, f.sort_order ASC, f.release_date DESC, c.name ASC`,
      lineUpParams
    );

    // Orphaned inventory rows (family_id IS NULL) — backward compat
    const [orphanRows] = await db.execute(`
      SELECT
        NULL                                              AS id,
        i.set_name                                        AS set_code,
        i.set_name                                        AS family_set_name,
        MIN(i.release_date)                               AS release_date,
        999                                               AS family_sort_order,
        NULL                                              AS game_id,
        i.game_title,
        NULL                                              AS display_label,
        c.name                                            AS category_name,
        COUNT(*)                                          AS category_count,
        SUM(i.stock_quantity)                             AS category_stock,
        SUM(i.is_bundle)                                  AS category_bundles,
        SUM(i.stock_quantity * i.cost_price)              AS category_cost_value,
        SUM(i.stock_quantity * i.price)                   AS category_retail_value
      FROM inventory i
      LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.family_id IS NULL AND i.product_type = 'sealed'
        AND i.set_name IS NOT NULL AND i.set_name != ''
      GROUP BY i.set_name, i.game_title, i.category_id, c.name
      ORDER BY i.game_title, i.set_name, c.name ASC`
    );

    const allRows = [...rows, ...orphanRows];
    const familyMap = {};
    allRows.forEach(row => {
      const key = row.id != null ? `id:${row.id}` : `orphan:${row.set_code}|||${row.game_title}`;
      if (!familyMap[key]) {
        familyMap[key] = {
          id:                 row.id,
          set_code:           row.set_code,
          set_name:           row.family_set_name,
          release_date:       row.release_date,
          sort_order:         row.family_sort_order,
          line_up_id:         row.line_up_id,
          line_up_name:       row.line_up_name,
          singles_count:      Number(row.singles_count) || 0,
          game_id:            row.game_id,
          game_title:         row.game_title,
          display_label:      row.display_label,
          total_products:     0,
          total_stock:        0,
          bundle_count:       0,
          total_cost_value:   0,
          total_retail_value: 0,
          categories:         []
        };
      }
      const f = familyMap[key];
      f.total_products    += Number(row.category_count);
      f.total_stock       += Number(row.category_stock);
      f.bundle_count      += Number(row.category_bundles);
      f.total_cost_value  += Number(row.category_cost_value   || 0);
      f.total_retail_value+= Number(row.category_retail_value || 0);
      if (Number(row.category_count) > 0) {
        f.categories.push({ name: row.category_name || 'Uncategorized', stock: Number(row.category_stock) });
      }
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
      WHERE i.set_name = ? AND i.product_type <> 'single'
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

// Create a new family
// Seed a family's `categories` from the chosen per-IP configs (§1.4/1.5). Runs on the caller's
// transaction connection. First-write-wins per (family_id, name): never overwrites an existing
// category. Only tiers from configs that belong to `gameId` are used; shared names are claimed by
// the first applied config (config-application order, then tier). Returns the number seeded.
async function seedFamilyCategories(conn, familyId, gameId, configIds) {
  if (!Array.isArray(configIds) || !configIds.length) return 0;
  const [tiers] = await conn.query(
    `SELECT t.category_name, t.tier, t.qty_per_parent
       FROM product_config_tiers t
       JOIN product_configs c ON c.id = t.config_id
      WHERE t.config_id IN (?) AND c.game_id = ?
      ORDER BY FIELD(t.config_id, ?) ASC, t.tier ASC, t.id ASC`,
    [configIds, gameId, configIds]
  );
  const claimed = new Set();
  let seededCount = 0;
  for (const t of tiers) {
    const key = t.category_name.toLowerCase();
    if (claimed.has(key)) continue; // an earlier config already seeded this name
    claimed.add(key);
    // Guarded insert: skip if a category with this name already exists for the family.
    const [[existing]] = await conn.execute(
      'SELECT id FROM categories WHERE family_id = ? AND name = ?', [familyId, t.category_name]
    );
    if (existing) continue;
    await conn.execute(
      'INSERT INTO categories (family_id, name, tier, default_qty_per_parent) VALUES (?, ?, ?, ?)',
      [familyId, t.category_name, t.tier, t.qty_per_parent ?? null]
    );
    seededCount++;
  }
  return seededCount;
}

app.post('/api/inventory/families', async (req, res) => {
  const { game_id, set_code, set_name, release_date, line_up_id, config_ids } = req.body;
  if (!game_id || !set_code || !set_name) {
    return res.status(400).json({ error: 'game_id, set_code, and set_name are required' });
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO inventory_families (game_id, set_code, set_name, release_date, line_up_id) VALUES (?, ?, ?, ?, ?)',
      [game_id, set_code.trim(), set_name.trim(), release_date || null, line_up_id || null]
    );
    const familyId = result.insertId;
    const seededCount = await seedFamilyCategories(conn, familyId, game_id, config_ids);
    await conn.commit();
    res.status(201).json({ id: familyId, seeded_categories: seededCount, message: 'Family created' });
  } catch (error) {
    await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A family with this set code already exists for this game' });
    res.status(500).json({ error: 'Failed to create family' });
  } finally { conn.release(); }
});

// Apply configs to an EXISTING family (re-seed / add category structure after creation).
app.post('/api/inventory/families/:id/apply-configs', async (req, res) => {
  const { config_ids } = req.body;
  if (!Array.isArray(config_ids) || !config_ids.length) {
    return res.status(400).json({ error: 'config_ids array required' });
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[family]] = await conn.execute(
      'SELECT id, game_id FROM inventory_families WHERE id = ?', [req.params.id]
    );
    if (!family) { await conn.rollback(); return res.status(404).json({ error: 'Family not found' }); }
    const seededCount = await seedFamilyCategories(conn, family.id, family.game_id, config_ids);
    await conn.commit();
    res.json({ seeded_categories: seededCount, message: 'Configurations applied' });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: 'Failed to apply configurations' });
  } finally { conn.release(); }
});

// Get family by ID including all products (supports empty families)
app.get('/api/inventory/family-by-id/:id', async (req, res) => {
  try {
    const [[family]] = await db.execute(
      `SELECT f.*, g.name AS game_title, g.id AS game_id
       FROM inventory_families f
       JOIN games g ON g.id = f.game_id
       WHERE f.id = ?`,
      [req.params.id]
    );
    if (!family) return res.status(404).json({ error: 'Family not found' });

    const [rows] = await db.execute(`
      SELECT
        i.id, i.card_name, i.game_title, i.set_name, i.family_id, i.sort_order,
        i.stock_quantity, i.price, i.cost_price, i.is_bundle, i.barcode,
        i.quick_description, i.long_description, i.category_id,
        c.name                    AS category_name,
        c.tier                    AS category_tier,
        pb_up.parent_product_id   AS parent_id,
        pb_up.quantity_per_parent AS qty_in_parent
      FROM inventory i
      LEFT JOIN categories      c     ON c.id = i.category_id
      LEFT JOIN product_bundles pb_up ON pb_up.child_product_id = i.id
      WHERE i.family_id = ? AND i.product_type <> 'single'
      ORDER BY i.sort_order ASC, i.is_bundle DESC, i.id ASC
    `, [req.params.id]);

    if (rows.length === 0) return res.json({ family, products: [] });

    const productIds = rows.map(r => r.id);
    const placeholders = productIds.map(() => '?').join(',');

    const [[children], [waves], [reservations]] = await Promise.all([
      db.execute(`
        SELECT pb.parent_product_id, pb.child_product_id, pb.id AS bundle_id, pb.quantity_per_parent,
               i.card_name AS child_name, i.stock_quantity AS child_stock
        FROM product_bundles pb JOIN inventory i ON i.id = pb.child_product_id
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

    const childMap = {}, waveMap = {}, reservationMap = {};
    children.forEach(c => { if (!childMap[c.parent_product_id]) childMap[c.parent_product_id] = []; childMap[c.parent_product_id].push(c); });
    waves.forEach(w => { if (!waveMap[w.inventory_id]) waveMap[w.inventory_id] = []; waveMap[w.inventory_id].push(w); });
    reservations.forEach(r => { if (!reservationMap[r.parent_product_id]) reservationMap[r.parent_product_id] = []; reservationMap[r.parent_product_id].push(r); });

    const products = rows.map(r => ({
      ...r,
      children: childMap[r.id] || [],
      waves: waveMap[r.id] || [],
      reservations: reservationMap[r.id] || []
    }));

    res.json({ family, products });
  } catch (error) { res.status(500).json({ error: 'Failed to fetch family' }); }
});

// ==========================================
// 4.1 SINGLES MANAGEMENT
// ==========================================

// Get all families — used by both sealed and singles sidebars
// Extended with family_id and distinct_rarities for singles revamp
app.get('/api/inventory/all-families', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        f.id AS family_id,
        f.set_code,
        f.set_name,
        g.id AS game_id,
        g.name AS game_title,
        f.release_date,
        COUNT(CASE WHEN i.product_type = 'single' THEN 1 END) AS singles_count,
        (SELECT GROUP_CONCAT(DISTINCT rarity ORDER BY rarity SEPARATOR ',')
         FROM inventory
         WHERE family_id = f.id AND product_type = 'single' AND rarity IS NOT NULL AND rarity != '') AS rarities_csv
      FROM inventory_families f
      JOIN games g ON g.id = f.game_id
      LEFT JOIN inventory i ON i.family_id = f.id
      GROUP BY f.id, f.set_code, f.set_name, g.id, g.name, g.sort_order, f.sort_order, f.release_date
      ORDER BY g.sort_order, g.name, f.release_date DESC, f.set_name
    `);
    const result = rows.map(r => ({
      ...r,
      singles_count: parseInt(r.singles_count) || 0,
      distinct_rarities: r.rarities_csv ? r.rarities_csv.split(',') : []
    }));
    // Remove the raw csv field
    result.forEach(r => delete r.rarities_csv);
    res.json(result);
  } catch (error) { res.status(500).json({ error: 'Failed to fetch families' }); }
});

// Get list of sets that have singles (legacy — kept for backward compat)
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

// Paginated, searchable, sortable singles list grouped by card
app.get('/api/inventory/singles', async (req, res) => {
  let { family_id, set, search, rarity, in_stock_only, sort, limit, offset } = req.query;

  // Resolve family_id — accept either family_id (int) or set= (set_code alias)
  if (!family_id && set) {
    try {
      const [[fam]] = await db.execute(
        'SELECT id FROM inventory_families WHERE set_code = ?', [set]
      );
      if (!fam) return res.status(400).json({ error: `No family found with set_code '${set}'` });
      family_id = fam.id;
    } catch (e) { return res.status(500).json({ error: 'Family lookup failed' }); }
  }
  if (!family_id) return res.status(400).json({ error: 'family_id or set is required' });

  const VALID_SORTS = ['card_id_asc', 'card_name_asc', 'price_desc', 'stock_desc', 'updated_desc'];
  sort = sort || 'card_id_asc';
  if (!VALID_SORTS.includes(sort)) return res.status(400).json({ error: `sort must be one of: ${VALID_SORTS.join(', ')}` });

  limit = Math.min(parseInt(limit) || 50, 200);
  offset = parseInt(offset) || 0;

  const sortMap = {
    card_id_asc:   'COALESCE(card_id, \'~~~~~\') ASC, card_name ASC',
    card_name_asc: 'card_name ASC',
    price_desc:    'MAX(price) DESC',
    stock_desc:    'SUM(stock_quantity) DESC',
    updated_desc:  'MAX(updated_at) DESC'
  };

  try {
    // Build WHERE clause (used in both the count and data queries)
    const baseWhere = ['family_id = ?', "product_type = 'single'"];
    const baseParams = [family_id];

    if (rarity) { baseWhere.push('rarity = ?'); baseParams.push(rarity); }
    if (in_stock_only === 'true') { baseWhere.push('stock_quantity > 0'); }

    // Search: AND-of-tokens across card_id, card_name, rarity
    const tokens = search ? search.trim().split(/\s+/).filter(Boolean) : [];
    for (const t of tokens) {
      baseWhere.push("LOWER(CONCAT_WS(' ', COALESCE(card_id,''), card_name, COALESCE(rarity,''))) LIKE ?");
      baseParams.push(`%${t.toLowerCase()}%`);
    }

    const whereClause = 'WHERE ' + baseWhere.join(' AND ');

    // Count distinct card groups
    const [[{ total_cards }]] = await db.execute(
      `SELECT COUNT(*) AS total_cards FROM (
         SELECT card_id, card_name, rarity FROM inventory ${whereClause} GROUP BY card_id, card_name, rarity
       ) AS grp`,
      baseParams
    );

    // Get paginated card groups with aggregates
    const [groupRows] = await db.execute(
      `SELECT card_id, card_name,
              rarity,
              SUM(stock_quantity) AS total_stock,
              MIN(price) AS price_min, MAX(price) AS price_max,
              COUNT(*) AS variant_count
       FROM inventory
       ${whereClause}
       GROUP BY card_id, card_name, rarity
       ORDER BY ${sortMap[sort]}
       LIMIT ${limit} OFFSET ${offset}`,
      baseParams
    );

    if (!groupRows.length) {
      return res.json({ rows: [], total_cards: parseInt(total_cards), limit, offset });
    }

    // Build rarity-aware WHERE for variant fetch using (card_id, rarity) tuple matching.
    // null card_id groups use (card_name, rarity) instead.
    const nonNullGroups = groupRows.filter(r => r.card_id != null);
    const nullGroups    = groupRows.filter(r => r.card_id == null);

    const variantWhereParts = [];
    const variantParams = [family_id];
    if (nonNullGroups.length) {
      variantWhereParts.push(
        `(i.card_id, COALESCE(i.rarity, '__NULL__')) IN (${nonNullGroups.map(() => '(?, ?)').join(', ')})`
      );
      for (const g of nonNullGroups) variantParams.push(g.card_id, g.rarity == null ? '__NULL__' : g.rarity);
    }
    if (nullGroups.length) {
      variantWhereParts.push(
        `(i.card_id IS NULL AND (i.card_name, COALESCE(i.rarity, '__NULL__')) IN (${nullGroups.map(() => '(?, ?)').join(', ')}))`
      );
      for (const g of nullGroups) variantParams.push(g.card_name, g.rarity == null ? '__NULL__' : g.rarity);
    }
    const variantWhere = variantWhereParts.length
      ? `AND (${variantWhereParts.join(' OR ')})`
      : 'AND 1=0';

    const [variantRows] = await db.execute(
      `SELECT i.id, i.card_id, i.card_name, i.rarity, i.card_condition, i.card_finish,
              i.price, i.stock_quantity, i.updated_at, i.image_url,
              sr.source AS ref_source, sr.source_url AS ref_source_url,
              sr.reference_price, sr.currency AS ref_currency, sr.scraped_at AS ref_scraped_at
       FROM inventory i
       LEFT JOIN (
         SELECT sr1.family_id, sr1.card_id, sr1.rarity, sr1.source, sr1.source_url,
                sr1.reference_price, sr1.currency, sr1.scraped_at
         FROM singles_reference sr1
         INNER JOIN (
           SELECT family_id, card_id, rarity, MAX(scraped_at) AS max_scraped_at
           FROM singles_reference
           GROUP BY family_id, card_id, rarity
         ) latest ON sr1.family_id  = latest.family_id
                 AND sr1.card_id   <=> latest.card_id
                 AND sr1.rarity    <=> latest.rarity
                 AND sr1.scraped_at = latest.max_scraped_at
       ) sr ON sr.family_id = i.family_id
           AND sr.card_id  <=> i.card_id
           AND sr.rarity   <=> i.rarity
       WHERE i.family_id = ? AND i.product_type = 'single' ${variantWhere}
       ORDER BY i.card_id, i.card_name, i.card_condition, i.card_finish`,
      variantParams
    );

    // Index variants by (card_id::rarity) or (__null__card_name::rarity)
    const variantMap = {};
    for (const v of variantRows) {
      const key = v.card_id != null
        ? `${v.card_id}::${v.rarity ?? ''}`
        : `__null__${v.card_name}::${v.rarity ?? ''}`;
      if (!variantMap[key]) variantMap[key] = [];
      variantMap[key].push({
        id: v.id,
        card_condition: v.card_condition,
        card_finish: v.card_finish,
        price: v.price,
        stock_quantity: v.stock_quantity,
        updated_at: v.updated_at,
        image_url: v.image_url,
        reference: v.ref_source ? {
          source: v.ref_source,
          source_url: v.ref_source_url,
          reference_price: v.reference_price,
          currency: v.ref_currency,
          scraped_at: v.ref_scraped_at
        } : null
      });
    }

    const rows = groupRows.map(g => {
      const key = g.card_id != null
        ? `${g.card_id}::${g.rarity ?? ''}`
        : `__null__${g.card_name}::${g.rarity ?? ''}`;
      return {
        card_id: g.card_id,
        card_name: g.card_name,
        rarity: g.rarity,
        variants: variantMap[key] || [],
        total_stock: parseInt(g.total_stock) || 0,
        price_min: parseFloat(g.price_min) || 0,
        price_max: parseFloat(g.price_max) || 0,
        variant_count: parseInt(g.variant_count) || 0
      };
    });

    res.json({ rows, total_cards: parseInt(total_cards), limit, offset });
  } catch (error) {
    console.error('[singles GET] error:', error);
    res.status(500).json({ error: 'Failed to fetch singles', detail: error.sqlMessage || error.message || String(error) });
  }
});

// Import singles reference data (and optionally scaffold inventory rows)
app.post('/api/inventory/singles/import', authenticate, async (req, res) => {
  const { family_id, source, source_url, scraped_at, cards, create_missing } = req.body;
  if (!family_id) return res.status(400).json({ error: 'family_id is required' });
  if (!Array.isArray(cards) || !cards.length) return res.status(400).json({ error: 'cards array is required' });

  const conn = await db.getConnection();
  try {
    const [[fam]] = await conn.execute('SELECT id FROM inventory_families WHERE id = ?', [family_id]);
    if (!fam) return res.status(400).json({ error: 'family_id does not exist' });

    await conn.beginTransaction();

    const summary = { received: cards.length, reference_upserted: 0, inventory_created: 0, inventory_skipped_existing: 0, errors: 0 };
    const errors = [];

    for (const card of cards) {
      try {
        const cardId = card.card_id || null;

        // Upsert singles_reference (skip if card_id is null — can't key reference without it)
        if (cardId) {
          await conn.execute(
            `INSERT INTO singles_reference
               (family_id, card_id, rarity, source, source_url, reference_price, currency, reference_image_url, scraped_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               reference_price = VALUES(reference_price),
               source_url = VALUES(source_url),
               scraped_at = VALUES(scraped_at),
               reference_image_url = VALUES(reference_image_url)`,
            [family_id, cardId, null, source || 'unknown', source_url || null,
             card.reference_price || 0, card.currency || 'JPY',
             card.image_url || null, scraped_at || new Date().toISOString()]
          );
          summary.reference_upserted++;
        }

        // Optionally create missing inventory row
        if (create_missing !== false) {
          // Catalog import is rarity-agnostic: one catalog row per (family, card_id). Rarity is set
          // per card later from the per-IP config, so we match without it to avoid duplicates.
          const [[existing]] = await conn.execute(
            `SELECT id FROM inventory WHERE family_id = ? AND card_id = ? AND product_type = 'single' LIMIT 1`,
            [family_id, cardId]
          );

          if (existing) {
            summary.inventory_skipped_existing++;
          } else {
            const [[famMeta]] = await conn.execute(
              `SELECT f.set_code, g.name AS game_title FROM inventory_families f JOIN games g ON g.id = f.game_id WHERE f.id = ?`,
              [family_id]
            );
            const [[maxSort]] = await conn.execute(
              'SELECT COALESCE(MAX(sort_order), 0) AS mx FROM inventory WHERE family_id = ?', [family_id]
            );
            const [insResult] = await conn.execute(
              `INSERT INTO inventory (family_id, game_title, set_name, card_id, card_name,
                price, cost_price, stock_quantity, product_type, card_condition, image_url, sort_order)
               VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'single', 'NM', ?, ?)`,
              [family_id, famMeta.game_title, famMeta.set_code,
               cardId, card.name || card.card_name || '',
               card.image_url || null, maxSort.mx + 1]
            );
            await logChange(conn, insResult.insertId, req.user?.username || 'system',
              'stock_quantity', null, 0, `Import: ${source || 'unknown'}`);
            summary.inventory_created++;
          }
        }
      } catch (err) {
        summary.errors++;
        errors.push({ card_id: card.card_id, name: card.name, error: err.message });
      }
    }

    await conn.commit();
    res.json({ summary, errors });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally { conn.release(); }
});

// Bulk stock-in for singles — each row creates a FIFO wave (stock + cost enter only through FIFO).
// Body: { items: [{ inventory_id, qty, unit_cost }], invoice_number? }
app.post('/api/inventory/singles/stock-in', authenticate, async (req, res) => {
  const { items, invoice_number } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array is required' });

  // Validate + normalise up front so the whole batch is all-or-nothing.
  const rows = [];
  for (const it of items) {
    const inventory_id = parseInt(it.inventory_id);
    const qty = parseInt(it.qty);
    const unit_cost = Number(it.unit_cost);
    if (!inventory_id) return res.status(400).json({ error: 'each item needs an inventory_id' });
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: `qty must be a positive integer (inventory_id ${inventory_id})` });
    if (!Number.isFinite(unit_cost) || unit_cost < 0) return res.status(400).json({ error: `unit_cost must be a non-negative number (inventory_id ${inventory_id})` });
    rows.push({ inventory_id, qty, unit_cost });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    let wavesCreated = 0, totalQty = 0;
    for (const r of rows) {
      const [[inv]] = await conn.execute(
        "SELECT id FROM inventory WHERE id = ? AND product_type = 'single'", [r.inventory_id]
      );
      if (!inv) { await conn.rollback(); return res.status(400).json({ error: `inventory_id ${r.inventory_id} is not a single` }); }
      await conn.execute(
        `INSERT INTO fifo (inventory_id, wave_name, cost_price, initial_qty, remaining_qty, arrival_date, is_active, invoice_number)
         VALUES (?, 'Stock-In', ?, ?, ?, CURDATE(), TRUE, ?)`,
        [r.inventory_id, r.unit_cost.toFixed(2), r.qty, r.qty, invoice_number || null]
      );
      await syncInventoryStock(r.inventory_id, conn, req.user.username, 'Singles Stock-In');
      wavesCreated++; totalQty += r.qty;
    }
    await conn.commit();
    res.json({ waves_created: wavesCreated, total_qty: totalQty, message: 'Stock-in complete' });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally { conn.release(); }
});

// Add new product — family_id is required (orphan inventory rows are not allowed)
app.post('/api/inventory/add', async (req, res) => {
  const {
    family_id, barcode, category_id, card_id, card_name,
    price, cost_price, stock_quantity, quick_description, long_description,
    product_type, card_condition, card_finish
  } = req.body;

  if (!family_id) return res.status(400).json({ error: 'family_id is required' });

  const conn = await db.getConnection();
  try {
    const [[fam]] = await conn.execute(
      `SELECT f.set_code, f.set_name AS fam_name, g.name AS game_title
       FROM inventory_families f JOIN games g ON g.id = f.game_id WHERE f.id = ?`,
      [family_id]
    );
    if (!fam) return res.status(400).json({ error: 'family_id does not match an existing family' });

    const [[maxSort]] = await conn.execute(
      'SELECT COALESCE(MAX(sort_order), 0) AS mx FROM inventory WHERE family_id = ?',
      [family_id]
    );
    const sortOrder = maxSort.mx + 1;

    const [result] = await conn.execute(
      `INSERT INTO inventory
        (family_id, barcode, game_title, set_name, category_id, card_id, card_name,
         price, cost_price, stock_quantity, quick_description, long_description,
         product_type, card_condition, card_finish, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        family_id, barcode || null, fam.game_title, fam.set_code,
        category_id || null, card_id || null, card_name,
        price || 0, cost_price || 0, stock_quantity || 0,
        quick_description || null, long_description || null,
        product_type || 'sealed', card_condition || null, card_finish || null, sortOrder
      ]
    );
    res.status(201).json({ id: result.insertId, message: 'Product registered!' });
  } catch (error) { res.status(500).json({ error: error.message }); }
  finally { conn.release(); }
});

// Update product — updated, added set_name + is_bundle + quick_description + long_description + card_id + card_name + product_type + rarity
app.put('/api/inventory/:id', authenticate, async (req, res) => {
  const { card_name, card_id, price, stock_quantity, cost_price, category_id, set_name, is_bundle, quick_description, long_description, product_type, card_condition, card_finish, rarity } = req.body;
  if (rarity !== undefined && typeof rarity === 'string' && rarity.length > 20) {
    return res.status(400).json({ error: 'rarity must be 20 characters or fewer' });
  }
  const conn = await db.getConnection();
  try {
    const [[old]] = await conn.execute('SELECT price FROM inventory WHERE id = ?', [req.params.id]);
    await conn.execute(
      `UPDATE inventory
       SET card_name = ?, card_id = ?, price = ?, stock_quantity = ?, cost_price = ?,
           category_id = ?, set_name = ?, is_bundle = ?, quick_description = ?, long_description = ?,
           product_type = ?, card_condition = ?, card_finish = ?, rarity = COALESCE(?, rarity)
       WHERE id = ?`,
      [card_name || null, card_id || null, price, stock_quantity, cost_price || 0,
       category_id || null, set_name || '', is_bundle || 0,
       quick_description || null, long_description || null,
       product_type || 'sealed', card_condition || null, card_finish || null,
       rarity !== undefined ? (rarity || null) : null, req.params.id]
    );
    await logChange(conn, req.params.id, req.user.username, 'price', old.price, price, 'Manual Edit');
    res.json({ message: 'Updated' });
  } catch (error) { res.status(500).json({ error: 'Update failed' }); }
  finally { conn.release(); }
});

// Delete product — cascades all FK-linked records in dependency order
app.delete('/api/inventory/:id', authenticate, async (req, res) => {
  const id = req.params.id;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM bundle_breakdown_log WHERE parent_product_id = ? OR child_product_id = ?', [id, id]);
    await conn.execute('DELETE FROM inventory_reservations WHERE parent_product_id = ?', [id]);
    await conn.execute('DELETE FROM inventory_change_log WHERE inventory_id = ?', [id]);
    await conn.execute('DELETE FROM outstock_items WHERE inventory_id = ?', [id]);
    await conn.execute('DELETE FROM customer_order_items WHERE inventory_id = ?', [id]);
    await conn.execute('DELETE FROM po_items WHERE inventory_id = ?', [id]);
    await conn.execute('DELETE FROM product_bundles WHERE parent_product_id = ? OR child_product_id = ?', [id, id]);
    await conn.execute('DELETE FROM fifo WHERE inventory_id = ?', [id]);
    await conn.execute('DELETE FROM inventory WHERE id = ?', [id]);
    await conn.commit();
    res.json({ message: 'Product deleted' });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally { conn.release(); }
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

// Reorder products within a family
app.patch('/api/inventory/reorder', authenticate, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (const item of items) {
      await conn.execute('UPDATE inventory SET sort_order = ? WHERE id = ?', [item.sort_order, item.id]);
    }
    await conn.commit();
    res.json({ message: 'Order updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// Reorder families within a game
app.patch('/api/inventory/families/reorder', authenticate, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (const item of items) {
      await conn.execute('UPDATE inventory_families SET sort_order = ? WHERE id = ?', [item.sort_order, item.id]);
    }
    await conn.commit();
    res.json({ message: 'Order updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// Edit family metadata — must be registered after /families/reorder (specific before generic)
app.patch('/api/inventory/families/:id', authenticate, async (req, res) => {
  const { set_name, set_code, release_date, line_up_id } = req.body;
  const fid = req.params.id;
  if (!set_name?.trim() && !set_code?.trim() && release_date === undefined && line_up_id === undefined) {
    return res.status(400).json({ error: 'Provide set_name, set_code, release_date, or line_up_id to update' });
  }
  const conn = await db.getConnection();
  try {
    const [[fam]] = await conn.execute('SELECT game_id FROM inventory_families WHERE id = ?', [fid]);
    if (!fam) return res.status(404).json({ error: 'Family not found' });

    const updates = [];
    const params = [];
    if (set_name !== undefined) { updates.push('set_name = ?'); params.push(set_name.trim()); }
    if (set_code !== undefined) { updates.push('set_code = ?'); params.push(set_code.trim()); }
    if (release_date !== undefined) { updates.push('release_date = ?'); params.push(release_date || null); }
    if (line_up_id !== undefined) { updates.push('line_up_id = ?'); params.push(line_up_id || null); }
    params.push(fid);

    await conn.execute(`UPDATE inventory_families SET ${updates.join(', ')} WHERE id = ?`, params);
    const [[updated]] = await conn.execute(
      'SELECT id, set_code, set_name, release_date FROM inventory_families WHERE id = ?', [fid]
    );
    res.json({ message: 'Family updated', family: updated });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A family with this set code already exists for this game' });
    res.status(500).json({ error: error.message });
  } finally { conn.release(); }
});

// ==========================================
// 4.5 FIFO WAVES
// ==========================================

// ==========================================
// 3.6 UNIT CONVERSION CHAIN
// ==========================================

// Recursive walk of product_bundles from rootProductId.
// Returns { product_id, product_name, category_id, category_name, tier, branches }
// Each branch = { label, path, terminal_category_id, terminal_category_name, cumulative_qty }
// Hard cap at depth 6. Returns null if product not found.
async function buildConversionChain(conn, rootProductId) {
  const [[root]] = await conn.execute(
    `SELECT i.id, i.card_name, i.category_id, c.name AS category_name, c.tier
     FROM inventory i LEFT JOIN categories c ON c.id = i.category_id
     WHERE i.id = ?`,
    [rootProductId]
  );
  if (!root) return null;

  // Returns an array of paths (each path = array of steps from root's first child down to a leaf)
  async function walk(productId, path, depth) {
    if (depth > 6) {
      console.warn(`[conversion-chain] depth cap hit at product ${productId}`);
      return [path];
    }
    const [children] = await conn.execute(
      `SELECT pb.child_product_id, pb.quantity_per_parent,
              i.card_name, i.category_id, c.name AS category_name, c.tier
       FROM product_bundles pb
       JOIN inventory i ON i.id = pb.child_product_id
       LEFT JOIN categories c ON c.id = i.category_id
       WHERE pb.parent_product_id = ?`,
      [productId]
    );
    if (!children.length) return [path]; // leaf — this path is a complete branch
    const branches = [];
    for (const child of children) {
      const prevCumulative = path.length ? path[path.length - 1].cumulative_qty : 1;
      const step = {
        product_id:    child.child_product_id,
        product_name:  child.card_name,
        category_id:   child.category_id,
        category_name: child.category_name,
        tier:          child.tier,
        qty_per_parent:  child.quantity_per_parent,
        cumulative_qty:  prevCumulative * child.quantity_per_parent
      };
      const sub = await walk(child.child_product_id, [...path, step], depth + 1);
      branches.push(...sub);
    }
    return branches;
  }

  const rawPaths = await walk(rootProductId, [], 1);

  // Deduplicate: same terminal category AND same cumulative factor → keep first only
  const seen = new Map();
  for (const path of rawPaths) {
    if (!path.length) continue;
    const t = path[path.length - 1];
    const key = `${t.category_id}_${t.cumulative_qty}`;
    if (!seen.has(key)) seen.set(key, path);
  }
  const uniquePaths = [...seen.values()];

  // Count how many unique paths share the same terminal category (for label disambiguation)
  const terminalCatCount = {};
  for (const path of uniquePaths) {
    const catId = path[path.length - 1].category_id;
    terminalCatCount[catId] = (terminalCatCount[catId] || 0) + 1;
  }

  const branches = uniquePaths.map(path => {
    const terminal = path[path.length - 1];
    const multiLabel = terminalCatCount[terminal.category_id] > 1 && path.length >= 2;
    const label = multiLabel
      ? `${terminal.product_name} via ${path[path.length - 2].product_name}`
      : terminal.product_name;
    return { label, path, terminal_category_id: terminal.category_id, terminal_category_name: terminal.category_name, cumulative_qty: terminal.cumulative_qty };
  });

  return { product_id: root.id, product_name: root.card_name, category_id: root.category_id, category_name: root.category_name, tier: root.tier, branches };
}

// GET /api/inventory/:id/conversion-chain
// Returns breakdown chain from this product so the frontend can build the "Enter as" dropdown.
// branches: [] means the product has no children — hide the conversion toggle.
app.get('/api/inventory/:id/conversion-chain', authenticate, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const chain = await buildConversionChain(conn, parseInt(req.params.id));
    if (!chain) return res.status(404).json({ error: 'Product not found' });
    res.json(chain);
  } catch (error) {
    res.status(500).json({ error: 'Failed to build conversion chain' });
  } finally { conn.release(); }
});

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
  const { wave_name, cost_price, initial_qty, arrival_date, invoice_number,
          entry_unit_category_id, entry_unit_qty } = req.body;
  const inventory_id = parseInt(req.params.id);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const wName = wave_name || 'Standard';
    let nativeQty = parseInt(initial_qty) || 0;
    let auditCatId   = null;
    let auditCatQty  = null;
    let auditCatName = null;

    // §3.3 — server-side conversion validation (never trust client's converted qty)
    if (entry_unit_category_id != null && entry_unit_qty != null) {
      const chain = await buildConversionChain(conn, inventory_id);
      if (!chain) { await conn.rollback(); return res.status(404).json({ error: 'Product not found' }); }

      const catId     = parseInt(entry_unit_category_id);
      const foreignQty = parseInt(entry_unit_qty);
      if (isNaN(catId) || isNaN(foreignQty) || foreignQty < 1) {
        await conn.rollback();
        return res.status(400).json({ error: 'entry_unit_category_id and entry_unit_qty must be positive integers' });
      }

      const matching = chain.branches.filter(b => b.terminal_category_id === catId);
      if (!matching.length) {
        await conn.rollback();
        return res.status(400).json({ error: `Category ${catId} is not a descendant of this product's breakdown chain` });
      }
      if (matching.length > 1) {
        await conn.rollback();
        return res.status(400).json({ error: 'Ambiguous: multiple paths lead to this category with different factors. Disambiguation via branch selection is not yet implemented.' });
      }

      const branch  = matching[0];
      const divisor = branch.cumulative_qty;
      if (foreignQty % divisor !== 0) {
        await conn.rollback();
        return res.status(400).json({ error: `${foreignQty} ${branch.terminal_category_name} is not a multiple of ${divisor} (the conversion factor for this chain). Adjust the input or create separate waves for the remainder.` });
      }

      nativeQty    = foreignQty / divisor;
      auditCatId   = catId;
      auditCatQty  = foreignQty;
      auditCatName = branch.terminal_category_name;
    }

    const today = new Date().toISOString().slice(0, 10);
    const [result] = await conn.execute(
      `INSERT INTO fifo (inventory_id, wave_name, cost_price, initial_qty, remaining_qty, arrival_date, is_active, invoice_number, entry_unit_category_id, entry_unit_qty)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?)`,
      [inventory_id, wName, cost_price || 0, nativeQty, nativeQty,
       arrival_date || today, invoice_number || null, auditCatId, auditCatQty]
    );

    const newTotal = await syncInventoryStock(inventory_id, conn, req.user.username, `${wName} Created`);

    // §3.5 — append conversion annotation to the change log when entry unit was used
    if (auditCatId != null) {
      await logChange(conn, inventory_id, req.user.username,
        'entry_unit', null,
        `${nativeQty} (entered as ${auditCatQty} ${auditCatName})`,
        `${wName} Created`);
    }

    await conn.commit();
    res.status(201).json({
      id: result.insertId, message: 'Wave added', total_stock: newTotal,
      native_qty: nativeQty, wave_name: wName, conversion_applied: auditCatId != null
    });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally { conn.release(); }
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

// Tier-based breakdown validation. Returns {ok, reason}.
// ok iff both products belong to the same family AND parent tier < child tier.
// A NULL tier on either side blocks the breakdown (user must assign tier first).
async function canBreakdown(conn, parent_product_id, child_product_id) {
  const [[parent]] = await conn.execute(
    `SELECT i.family_id, c.tier AS category_tier
     FROM inventory i LEFT JOIN categories c ON c.id = i.category_id
     WHERE i.id = ?`, [parent_product_id]
  );
  const [[child]] = await conn.execute(
    `SELECT i.family_id, c.tier AS category_tier
     FROM inventory i LEFT JOIN categories c ON c.id = i.category_id
     WHERE i.id = ?`, [child_product_id]
  );
  if (!parent) return { ok: false, reason: 'Parent product not found' };
  if (!child)  return { ok: false, reason: 'Child product not found' };
  if (parent.family_id !== child.family_id) {
    return { ok: false, reason: 'Products must belong to the same family' };
  }
  if (parent.category_tier == null) {
    return { ok: false, reason: "Parent product's category has no tier assigned — set a tier first" };
  }
  if (child.category_tier == null) {
    return { ok: false, reason: "Child product's category has no tier assigned — set a tier first" };
  }
  if (parent.category_tier >= child.category_tier) {
    return { ok: false, reason: `Breakdown blocked: parent tier (${parent.category_tier}) must be lower than child tier (${child.category_tier})` };
  }
  return { ok: true, reason: null };
}

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

// Link a child product to a parent (creates breakdown relationship)
app.post('/api/bundles', authenticate, async (req, res) => {
  const { parent_product_id, child_product_id, quantity_per_parent, notes } = req.body;
  if (!parent_product_id || !child_product_id) {
    return res.status(400).json({ error: 'parent_product_id and child_product_id are required' });
  }
  const conn = await db.getConnection();
  try {
    const check = await canBreakdown(conn, parseInt(parent_product_id), parseInt(child_product_id));
    if (!check.ok) return res.status(400).json({ error: check.reason });

    // §3.4 — resolve quantity_per_parent: explicit body value > child category default > 400
    // Pre-fill from categories.default_qty_per_parent when client omits the field.
    let resolvedQty = quantity_per_parent != null ? parseInt(quantity_per_parent) : null;
    if (resolvedQty == null || isNaN(resolvedQty)) {
      const [[childRow]] = await conn.execute(
        `SELECT c.default_qty_per_parent
         FROM inventory i LEFT JOIN categories c ON c.id = i.category_id
         WHERE i.id = ?`, [child_product_id]
      );
      resolvedQty = childRow?.default_qty_per_parent ?? null;
    }
    if (resolvedQty == null || resolvedQty < 1) {
      return res.status(400).json({ error: 'quantity_per_parent is required (or set a default on the child\'s category)' });
    }

    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT INTO product_bundles (parent_product_id, child_product_id, quantity_per_parent, notes)
       VALUES (?, ?, ?, ?)`,
      [parent_product_id, child_product_id, resolvedQty, notes || null]
    );
    await conn.execute('UPDATE inventory SET is_bundle = 1 WHERE id = ?', [parent_product_id]);
    await conn.execute(
      `INSERT INTO relationship_audit (action, parent_product_id, child_product_id, changed_by, notes)
       VALUES ('break_created', ?, ?, ?, ?)`,
      [parent_product_id, child_product_id, req.user.username, notes || null]
    );
    await conn.commit();
    res.status(201).json({ id: result.insertId, message: 'Child product linked' });
  } catch (error) {
    await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Relationship already exists' });
    res.status(500).json({ error: error.message });
  } finally { conn.release(); }
});

// Check if a parent-child relationship can be reversed (child FIFO deleted + qty restored)
app.get('/api/bundles/:id/reversibility', async (req, res) => {
  try {
    const [[pb]] = await db.execute(
      'SELECT parent_product_id, child_product_id FROM product_bundles WHERE id = ?', [req.params.id]
    );
    if (!pb) return res.status(404).json({ error: 'Relationship not found' });

    // Find the most recent breakdown log entry for this parent-child pair
    const [[log]] = await db.execute(
      `SELECT child_wave_id, parent_wave_id, quantity_broken, broken_at
       FROM bundle_breakdown_log
       WHERE parent_product_id = ? AND child_product_id = ?
       ORDER BY broken_at DESC LIMIT 1`,
      [pb.parent_product_id, pb.child_product_id]
    );

    if (!log || !log.child_wave_id) {
      return res.json({
        reversible: false,
        blocker: 'No breakdown log found for this relationship — unlink only',
        child_fifo_id: null, child_fifo_qty: null, parent_fifo_id: null
      });
    }

    // Check for sub-children of the child FIFO wave
    const [[subChildren]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM fifo WHERE parent_fifo_id = ? AND is_active = TRUE',
      [log.child_wave_id]
    );

    // Conservative outstock check: any non-voided outstock on the child product since the breakdown
    // (outstock_items does not store wave IDs, so we cannot narrow to the specific wave)
    const [[outstockCheck]] = await db.execute(
      `SELECT COUNT(*) AS cnt
       FROM outstock_transactions ot
       JOIN outstock_items oi ON oi.transaction_id = ot.id
       WHERE oi.inventory_id = ? AND ot.voided_at IS NULL
         AND ot.transaction_date >= DATE(?)`,
      [pb.child_product_id, log.broken_at]
    );

    const [[childWave]] = await db.execute(
      'SELECT remaining_qty FROM fifo WHERE id = ? AND is_active = TRUE',
      [log.child_wave_id]
    );

    if (subChildren.cnt > 0) {
      return res.json({
        reversible: false,
        blocker: `Child wave has ${subChildren.cnt} sub-breakdown(s). Cannot reverse without breaking the audit trail.`,
        child_fifo_id: log.child_wave_id,
        child_fifo_qty: childWave?.remaining_qty ?? null,
        parent_fifo_id: log.parent_wave_id
      });
    }
    if (outstockCheck.cnt > 0) {
      return res.json({
        reversible: false,
        blocker: `Child product has ${outstockCheck.cnt} outstock transaction(s) since the breakdown date. Cannot reverse.`,
        child_fifo_id: log.child_wave_id,
        child_fifo_qty: childWave?.remaining_qty ?? null,
        parent_fifo_id: log.parent_wave_id
      });
    }

    res.json({
      reversible: true,
      blocker: null,
      child_fifo_id: log.child_wave_id,
      child_fifo_qty: childWave?.remaining_qty ?? null,
      parent_fifo_id: log.parent_wave_id
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Remove or reverse a parent-child relationship.
// ?action=reverse  → Branch A: delete child FIFO, restore qty to parent FIFO
// ?action=unlink   → Branch B: delete product_bundles row only, no FIFO change
// No action param  → 400
app.delete('/api/bundles/:id', authenticate, async (req, res) => {
  const { action } = req.query;
  if (!action) return res.status(400).json({ error: 'action query param required: "reverse" or "unlink"' });
  if (!['reverse', 'unlink'].includes(action)) {
    return res.status(400).json({ error: 'action must be "reverse" or "unlink"' });
  }

  const conn = await db.getConnection();
  try {
    const [[pb]] = await conn.execute(
      'SELECT parent_product_id, child_product_id FROM product_bundles WHERE id = ?', [req.params.id]
    );
    if (!pb) return res.status(404).json({ error: 'Relationship not found' });

    await conn.beginTransaction();

    if (action === 'reverse') {
      // Re-check reversibility server-side (don't trust client)
      const [[log]] = await conn.execute(
        `SELECT child_wave_id, parent_wave_id, quantity_broken, broken_at
         FROM bundle_breakdown_log
         WHERE parent_product_id = ? AND child_product_id = ?
         ORDER BY broken_at DESC LIMIT 1`,
        [pb.parent_product_id, pb.child_product_id]
      );
      if (!log || !log.child_wave_id) {
        await conn.rollback();
        return res.status(400).json({ error: 'No breakdown log found — use action=unlink instead' });
      }

      const [[subChildren]] = await conn.execute(
        'SELECT COUNT(*) AS cnt FROM fifo WHERE parent_fifo_id = ? AND is_active = TRUE',
        [log.child_wave_id]
      );
      const [[outstockCheck]] = await conn.execute(
        `SELECT COUNT(*) AS cnt FROM outstock_transactions ot
         JOIN outstock_items oi ON oi.transaction_id = ot.id
         WHERE oi.inventory_id = ? AND ot.voided_at IS NULL AND ot.transaction_date >= DATE(?)`,
        [pb.child_product_id, log.broken_at]
      );

      if (subChildren.cnt > 0 || outstockCheck.cnt > 0) {
        await conn.rollback();
        return res.status(409).json({ error: 'Relationship is no longer reversible — use action=unlink' });
      }

      const [[childWave]] = await conn.execute(
        'SELECT remaining_qty FROM fifo WHERE id = ? AND is_active = TRUE',
        [log.child_wave_id]
      );
      const qtyToRestore = childWave?.remaining_qty ?? 0;

      // Soft-delete child FIFO line
      await conn.execute('UPDATE fifo SET is_active = 0 WHERE id = ?', [log.child_wave_id]);

      // Restore quantity to parent FIFO wave if it still exists
      if (log.parent_wave_id && qtyToRestore > 0) {
        await conn.execute(
          'UPDATE fifo SET remaining_qty = remaining_qty + ? WHERE id = ?',
          [qtyToRestore, log.parent_wave_id]
        );
      }

      await conn.execute('DELETE FROM product_bundles WHERE id = ?', [req.params.id]);

      await syncInventoryStock(pb.parent_product_id, conn, req.user.username, 'Breakdown Reversed');
      await syncInventoryStock(pb.child_product_id,  conn, req.user.username, 'Breakdown Reversed');

      // Flip is_bundle if parent has no more children
      const [[remaining]] = await conn.execute(
        'SELECT COUNT(*) AS cnt FROM product_bundles WHERE parent_product_id = ?', [pb.parent_product_id]
      );
      if (remaining.cnt === 0) {
        await conn.execute('UPDATE inventory SET is_bundle = 0 WHERE id = ?', [pb.parent_product_id]);
      }

      await conn.execute(
        `INSERT INTO relationship_audit
           (action, parent_product_id, child_product_id, parent_fifo_id, child_fifo_id, quantity, changed_by)
         VALUES ('break_reversed', ?, ?, ?, ?, ?, ?)`,
        [pb.parent_product_id, pb.child_product_id, log.parent_wave_id, log.child_wave_id, qtyToRestore, req.user.username]
      );

      await conn.commit();
      return res.json({ message: `Breakdown reversed: ${qtyToRestore} unit(s) restored to parent FIFO` });
    }

    // action === 'unlink'
    await conn.execute('DELETE FROM product_bundles WHERE id = ?', [req.params.id]);

    const [[remaining]] = await conn.execute(
      'SELECT COUNT(*) AS cnt FROM product_bundles WHERE parent_product_id = ?', [pb.parent_product_id]
    );
    if (remaining.cnt === 0) {
      await conn.execute('UPDATE inventory SET is_bundle = 0 WHERE id = ?', [pb.parent_product_id]);
    }

    await conn.execute(
      `INSERT INTO relationship_audit
         (action, parent_product_id, child_product_id, changed_by)
       VALUES ('unlinked_only', ?, ?, ?)`,
      [pb.parent_product_id, pb.child_product_id, req.user.username]
    );

    await conn.commit();
    res.json({ message: 'Relationship unlinked (FIFO unchanged)' });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally { conn.release(); }
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
    const check = await canBreakdown(conn, parseInt(source_id), parseInt(target_id));
    if (!check.ok) return res.status(400).json({ error: check.reason });

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

// Open a sealed product (case or box) into singles — outstock-to-singles with cost allocation.
// Deducts the sealed item's FIFO oldest-first, allocates its cost across the pulled singles
// (explicit unit_cost for valuable cards, remainder spread across is_junk cards), and creates
// one child FIFO wave per single. Records pack_openings + pack_opening_items + outstock_wave_log.
app.post('/api/inventory/open-sealed', authenticate, async (req, res) => {
  if (!req.user || req.user.username === 'unknown') {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  const { sealed_inventory_id, qty_opened, transaction_date, notes, items } = req.body;
  const sealedId = parseInt(sealed_inventory_id);
  const openQty  = parseInt(qty_opened);

  if (!sealedId || !openQty || openQty < 1) {
    return res.status(400).json({ error: 'sealed_inventory_id and qty_opened (>=1) are required' });
  }
  if (!transaction_date) {
    return res.status(400).json({ error: 'transaction_date is required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }
  const seen = new Set();
  for (const it of items) {
    if (!it.single_inventory_id || !it.qty_pulled || it.qty_pulled < 1) {
      return res.status(400).json({ error: 'Each item needs single_inventory_id and qty_pulled (>=1)' });
    }
    if (seen.has(it.single_inventory_id)) {
      return res.status(400).json({ error: `Single ${it.single_inventory_id} appears more than once` });
    }
    seen.add(it.single_inventory_id);
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Source must be a sealed product (case or box — both are product_type 'sealed')
    const [[sealed]] = await conn.execute(
      'SELECT id, card_name, product_type FROM inventory WHERE id = ?', [sealedId]
    );
    if (!sealed) throw new Error('Sealed product not found');
    if (sealed.product_type !== 'sealed') throw new Error('Source must be a sealed product (case or box)');

    // Deduct the sealed item's FIFO oldest-first, capturing cost basis
    const sourceDeductions = await deductFifoWaves(conn, sealedId, openQty);
    const sourceCost = sourceDeductions.reduce((sum, d) => sum + Number(d.unit_cost) * d.qty, 0);
    const primarySourceWaveId = sourceDeductions[0]?.wave_id || null;

    // Cost allocation: explicit cost for rares + remainder spread across junk
    let sumExplicit = 0;
    let junkQtyTotal = 0;
    for (const it of items) {
      if (it.is_junk) junkQtyTotal += Number(it.qty_pulled);
      else sumExplicit += (Number(it.unit_cost) || 0) * Number(it.qty_pulled);
    }

    const remainder = +(sourceCost - sumExplicit).toFixed(2);
    if (remainder < -0.005) {
      throw new Error(`Allocated rare cost (${sumExplicit.toFixed(2)}) exceeds source cost (${sourceCost.toFixed(2)})`);
    }
    if (junkQtyTotal === 0 && remainder > 0.005) {
      throw new Error(`Unallocated cost of ${remainder.toFixed(2)} remains — mark at least one card as junk or assign more cost`);
    }
    const junkUnit = junkQtyTotal > 0 ? remainder / junkQtyTotal : 0;

    // Book the outstock transaction (type pack_opening) + the sealed line
    const [txnResult] = await conn.execute(
      `INSERT INTO outstock_transactions (transaction_type, transaction_date, notes, changed_by)
       VALUES ('pack_opening', ?, ?, ?)`,
      [transaction_date, notes || `Opened ${openQty} × ${sealed.card_name}`, req.user.username]
    );
    const outstock_id = txnResult.insertId;

    const [sealedItemResult] = await conn.execute(
      `INSERT INTO outstock_items (transaction_id, inventory_id, qty, unit_price, adjustment_reason, notes)
       VALUES (?, ?, ?, NULL, NULL, 'Sealed opening')`,
      [outstock_id, sealedId, openQty]
    );
    const sealedOutstockItemId = sealedItemResult.insertId;

    // Log which source waves were consumed → void-safe restore of the sealed stock
    for (const d of sourceDeductions) {
      await conn.execute(
        `INSERT INTO outstock_wave_log (outstock_item_id, fifo_id, qty_deducted, unit_cost)
         VALUES (?, ?, ?, ?)`,
        [sealedOutstockItemId, d.wave_id, d.qty, d.unit_cost]
      );
    }

    // pack_openings header
    const [poResult] = await conn.execute(
      `INSERT INTO pack_openings (outstock_id, sealed_inventory_id, qty_opened, total_cost, status, opened_by, completed_at)
       VALUES (?, ?, ?, ?, 'Completed', ?, NOW())`,
      [outstock_id, sealedId, openQty, sourceCost.toFixed(2), req.user.id || null]
    );
    const pack_opening_id = poResult.insertId;

    // Lot identity shared across all child waves (one wave per single per opening)
    const lotName = `Opening: ${sealed.card_name} ${transaction_date}`.slice(0, 50);
    const lotInvoice = `PO-${pack_opening_id}`;

    for (const it of items) {
      const singleId  = parseInt(it.single_inventory_id);
      const qtyPulled = Number(it.qty_pulled);
      const unitCost  = it.is_junk ? junkUnit : (Number(it.unit_cost) || 0);

      const [waveResult] = await conn.execute(
        `INSERT INTO fifo (inventory_id, wave_name, cost_price, initial_qty, remaining_qty, arrival_date, is_active, invoice_number, parent_fifo_id)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, ?, ?)`,
        [singleId, lotName, unitCost.toFixed(2), qtyPulled, qtyPulled, transaction_date, lotInvoice, primarySourceWaveId]
      );
      const fifoWaveId = waveResult.insertId;

      await conn.execute(
        `INSERT INTO pack_opening_items (pack_opening_id, single_inventory_id, qty_pulled, unit_cost_assigned, fifo_wave_id)
         VALUES (?, ?, ?, ?, ?)`,
        [pack_opening_id, singleId, qtyPulled, unitCost.toFixed(2), fifoWaveId]
      );

      await syncInventoryStock(singleId, conn, req.user.username, `Pack Opening #${pack_opening_id}`);
    }

    await syncInventoryStock(sealedId, conn, req.user.username, `Pack Opening #${pack_opening_id}`);

    await conn.commit();
    res.status(201).json({
      pack_opening_id,
      outstock_id,
      source_cost: +sourceCost.toFixed(2),
      allocated_explicit: +sumExplicit.toFixed(2),
      junk_unit_cost: +junkUnit.toFixed(2),
      singles: items.length,
      message: `Opened ${openQty} × ${sealed.card_name} into ${items.length} single line(s)`
    });
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
      'SELECT stock_quantity, card_name FROM inventory WHERE id = ?', [parent_id]
    );
    if (!parent) return res.status(404).json({ error: 'Product not found' });

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

    const check = await canBreakdown(conn, reservation.parent_product_id, parseInt(target_id));
    if (!check.ok) return res.status(400).json({ error: check.reason });

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
    `SELECT id, remaining_qty, wave_name, cost_price
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
    deductions.push({ wave_id: wave.id, wave_name: wave.wave_name, qty: take, unit_cost: wave.cost_price });
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
  if (!req.user || req.user.username === 'unknown') {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

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

    const deductionsByItem = [];
    for (const item of items) {
      const deductions = await deductFifoWaves(conn, item.inventory_id, item.qty);
      deductionsByItem.push(deductions);
      const source = transaction_type === 'sale' ? 'Sale' : item.adjustment_reason;
      await syncInventoryStock(item.inventory_id, conn, req.user.username, source);
    }

    const [txnResult] = await conn.execute(
      `INSERT INTO outstock_transactions (transaction_type, customer_id, transaction_date, notes, changed_by)
       VALUES (?, ?, ?, ?, ?)`,
      [transaction_type, customer_id || null, transaction_date, notes || null, req.user.username]
    );
    const txn_id = txnResult.insertId;

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const [itemResult] = await conn.execute(
        `INSERT INTO outstock_items (transaction_id, inventory_id, qty, unit_price, adjustment_reason, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          txn_id, item.inventory_id, item.qty,
          transaction_type === 'sale' ? item.unit_price : null,
          transaction_type === 'adjustment' ? item.adjustment_reason : null,
          item.notes || null
        ]
      );
      const outstock_item_id = itemResult.insertId;

      // Record exactly which FIFO waves were consumed → void-safe + per-sale COGS
      for (const d of deductionsByItem[idx]) {
        await conn.execute(
          `INSERT INTO outstock_wave_log (outstock_item_id, fifo_id, qty_deducted, unit_cost)
           VALUES (?, ?, ?, ?)`,
          [outstock_item_id, d.wave_id, d.qty, d.unit_cost]
        );
      }
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

  const safeLimit  = Math.max(1, parseInt(limit)  || 25);
  const safeOffset = Math.max(0, parseInt(offset) || 0);

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
         ANY_VALUE(c.name) AS customer_name,
         COUNT(oi.id) AS items_count,
         SUM(oi.qty * COALESCE(oi.unit_price, 0)) AS total_value
       FROM outstock_transactions ot
       LEFT JOIN customers c ON c.id = ot.customer_id
       LEFT JOIN outstock_items oi ON oi.transaction_id = ot.id
       ${whereClause}
       GROUP BY ot.id
       ORDER BY ot.transaction_date DESC, ot.created_at DESC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params
    );

    res.json({ rows, total });
  } catch (err) {
    console.error('API /outstock ERROR:', err);
    res.status(500).json({ error: err.message || err.toString() });
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
      'SELECT id, voided_at, transaction_type FROM outstock_transactions WHERE id = ?', [req.params.id]
    );
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.voided_at) return res.status(400).json({ error: 'Transaction already voided' });

    const [items] = await conn.execute(
      'SELECT id, inventory_id, qty FROM outstock_items WHERE transaction_id = ?', [req.params.id]
    );

    await conn.beginTransaction();

    const today = new Date().toISOString().slice(0, 10);
    for (const item of items) {
      // Restore exactly the FIFO waves that were consumed, preserving cost layers.
      const [waveLogs] = await conn.execute(
        'SELECT fifo_id, qty_deducted FROM outstock_wave_log WHERE outstock_item_id = ?', [item.id]
      );

      if (waveLogs.length > 0) {
        for (const wl of waveLogs) {
          await conn.execute(
            'UPDATE fifo SET remaining_qty = remaining_qty + ?, is_active = TRUE WHERE id = ?',
            [wl.qty_deducted, wl.fifo_id]
          );
        }
      } else {
        // Legacy transactions predate the wave log — fall back to a generic restoring wave.
        await conn.execute(
          `INSERT INTO fifo (inventory_id, wave_name, cost_price, initial_qty, remaining_qty, arrival_date, is_active)
           VALUES (?, ?, 0, ?, ?, ?, TRUE)`,
          [item.inventory_id, `Outstock Void #${req.params.id}`, item.qty, item.qty, today]
        );
      }
      await syncInventoryStock(item.inventory_id, conn, req.user.username, `Outstock Void #${req.params.id}`);
    }

    // Pack openings: also reverse the child single waves created by the opening.
    if (txn.transaction_type === 'pack_opening') {
      const [[po]] = await conn.execute(
        'SELECT id FROM pack_openings WHERE outstock_id = ?', [req.params.id]
      );
      if (po) {
        const [poItems] = await conn.execute(
          `SELECT poi.single_inventory_id, poi.qty_pulled, poi.fifo_wave_id, f.remaining_qty
           FROM pack_opening_items poi
           LEFT JOIN fifo f ON f.id = poi.fifo_wave_id
           WHERE poi.pack_opening_id = ?`, [po.id]
        );

        // Guard: cannot void if any pulled single has already been sold/outstocked.
        for (const pi of poItems) {
          if (pi.fifo_wave_id != null && Number(pi.remaining_qty) < Number(pi.qty_pulled)) {
            throw new Error('Cannot void this opening: one or more pulled singles have already been outstocked. Void those transactions first.');
          }
        }

        for (const pi of poItems) {
          if (pi.fifo_wave_id != null) {
            await conn.execute(
              'UPDATE fifo SET remaining_qty = remaining_qty - ?, is_active = FALSE WHERE id = ?',
              [pi.qty_pulled, pi.fifo_wave_id]
            );
          }
          await syncInventoryStock(pi.single_inventory_id, conn, req.user.username, `Void Pack Opening #${po.id}`);
        }

        await conn.execute("UPDATE pack_openings SET status = 'Voided' WHERE id = ?", [po.id]);
      }
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
