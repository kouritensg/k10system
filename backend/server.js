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

// Register New Staff
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await db.execute(
      'INSERT INTO staff (username, password_hash) VALUES (?, ?)',
      [username, hashedPassword]
    );
    res.status(201).json({ message: 'Staff member registered successfully!' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: 'This username is already taken.' });
    } else {
      console.error(error);
      res.status(500).json({ error: 'Database connection error.' });
    }
  }
});

// Staff Login
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
      message: 'Login successful!',
      token: token,
      user: { id: user.id, username: user.username, role: user.role }
    });
  } catch (error) {
    console.error("Login Error:", error.message);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// ==========================================
// INVENTORY SYSTEM
// ==========================================

// Get All Products
app.get('/api/inventory', async (req, res) => {
  try {
    const [products] = await db.execute('SELECT * FROM inventory ORDER BY created_at DESC');
    res.json(products);
  } catch (error) {
    console.error("Database Error:", error.message);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// Add Product
app.post('/api/inventory/add', async (req, res) => {
  const { 
    barcode, game_title, product_type, card_id, card_name, set_name, rarity, price, stock_quantity 
  } = req.body;

  try {
    const [result] = await db.execute(
      `INSERT INTO inventory 
      (barcode, game_title, product_type, card_id, card_name, set_name, rarity, price, stock_quantity) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        barcode || null, 
        game_title || 'Hololive', 
        product_type || 'Single', 
        card_id || null, 
        card_name, 
        set_name || null, 
        rarity || null, 
        price, 
        stock_quantity
      ]
    );

    res.status(201).json({ message: 'Product added successfully!', id: result.insertId });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
       return res.status(400).json({ error: 'That Barcode or Card ID already exists.' });
    }
    console.error("Add Product Error:", error.message);
    res.status(500).json({ error: 'Failed to add product' });
  }
});

// Update Product
app.put('/api/inventory/:id', async (req, res) => {
  const { id } = req.params;
  const { price, stock_quantity } = req.body;

  try {
    const [result] = await db.execute(
      'UPDATE inventory SET price = ?, stock_quantity = ? WHERE id = ?',
      [price, stock_quantity, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ message: 'Product updated successfully' });
  } catch (error) {
    console.error("Update Product Error:", error.message);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete Product
app.delete('/api/inventory/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.execute('DELETE FROM inventory WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error("Delete Product Error:", error.message);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ==========================================
// EVENT SYSTEM (Updated with Payment Tracking)
// ==========================================

// Create Event
app.post('/api/events/create', async (req, res) => {
  const { title, game_title, event_date, entry_fee, max_players, description } = req.body;
  try {
    await db.execute(
      `INSERT INTO events (title, game_title, event_date, entry_fee, max_players, description) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [title, game_title, event_date, entry_fee, max_players, description]
    );
    res.status(201).json({ message: 'Event scheduled successfully!' });
  } catch (error) {
    console.error("Create Event Error:", error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// Get Events (With History Support)
app.get('/api/events', async (req, res) => {
  const { admin } = req.query; 

  try {
    let query = `SELECT * FROM events`;
    
    // Only show future events unless admin requests all
    if (admin !== 'true') {
        query += ` WHERE event_date >= NOW()`;
    }
    
    query += ` ORDER BY event_date DESC`; // Show newest first

    const [events] = await db.execute(query);
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// View Registered Players (Includes Payment Status)
app.get('/api/events/:id/players', async (req, res) => {
  const eventId = req.params.id;
  try {
    const [players] = await db.execute(
      `SELECT r.id as registration_id, c.name, c.contact_info, r.registered_at, r.has_paid 
       FROM event_registrations r
       JOIN customers c ON r.customer_id = c.id
       WHERE r.event_id = ?
       ORDER BY r.has_paid ASC, r.registered_at DESC`, 
      [eventId]
    );
    res.json(players);
  } catch (error) {
    console.error("Fetch Players Error:", error);
    res.status(500).json({ error: 'Failed to fetch player list' });
  }
});

// Join Event (Handles Payment Status + Transactions)
app.post('/api/events/join', async (req, res) => {
  const { event_id, player_name, contact_info, has_paid } = req.body;
  
  if (!player_name || !contact_info) {
      return res.status(400).json({ error: "Name and Contact Info are required." });
  }

  const connection = await db.getConnection(); 
  try {
    await connection.beginTransaction();

    // 1. Check Capacity
    const [rows] = await connection.execute('SELECT max_players, current_players FROM events WHERE id = ?', [event_id]);
    if (rows.length === 0) throw new Error('Event not found');
    if (rows[0].current_players >= rows[0].max_players) throw new Error('Event is full');

    // 2. Find or Create Customer
    let customer_id;
    const [existingCustomer] = await connection.execute('SELECT id FROM customers WHERE contact_info = ?', [contact_info]);

    if (existingCustomer.length > 0) {
      customer_id = existingCustomer[0].id;
    } else {
      const [newCust] = await connection.execute('INSERT INTO customers (name, contact_info) VALUES (?, ?)', [player_name, contact_info]);
      customer_id = newCust.insertId;
    }

    // 3. Register Player
    await connection.execute(
        'INSERT INTO event_registrations (event_id, customer_id, has_paid) VALUES (?, ?, ?)', 
        [event_id, customer_id, has_paid || false]
    );
    
    // 4. Update Event Count
    await connection.execute('UPDATE events SET current_players = current_players + 1 WHERE id = ?', [event_id]);

    await connection.commit();
    res.json({ message: 'Registration successful! See you there.' });

  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: 'You have already registered for this event!' });
    }
    console.error("Join Error:", error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  } finally {
    connection.release();
  }
});

// Toggle Payment Status
app.put('/api/events/registration/:id/toggle-pay', async (req, res) => {
    const regId = req.params.id;
    try {
        await db.execute('UPDATE event_registrations SET has_paid = NOT has_paid WHERE id = ?', [regId]);
        res.json({ message: 'Payment status updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update payment' });
    }
});

// ==========================================
// CUSTOMER CRM SYSTEM
// ==========================================

// List all customers
app.get('/api/customers', async (req, res) => {
    const { search } = req.query;
    try {
        let query = 'SELECT * FROM customers';
        let params = [];

        if (search) {
            query += ' WHERE name LIKE ? OR contact_info LIKE ?';
            params = [`%${search}%`, `%${search}%`];
        }

        query += ' ORDER BY created_at DESC';
        const [customers] = await db.execute(query, params);
        res.json(customers);
    } catch (error) {
        console.error("Fetch Customers Error:", error);
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// Manual Registration
app.post('/api/customers/create', async (req, res) => {
    const { name, contact_info } = req.body;
    
    if (!name || !contact_info) {
        return res.status(400).json({ error: "Name and Contact Info are required." });
    }

    try {
        const [result] = await db.execute(
            'INSERT INTO customers (name, contact_info) VALUES (?, ?)',
            [name, contact_info]
        );
        res.status(201).json({ message: 'Customer profile created!', id: result.insertId });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'A customer with this phone/email already exists.' });
        }
        res.status(500).json({ error: 'Failed to register customer.' });
    }
});

// Search Customer (Helper)
app.get('/api/customers/search', async (req, res) => {
    const { q } = req.query;
    try {
        const [rows] = await db.execute(
            `SELECT id, name, contact_info FROM customers WHERE name LIKE ? LIMIT 5`, 
            [`%${q}%`]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// Fetch Recent Events for Customer (Helper)
app.get('/api/customers/:id/recent-events', async (req, res) => {
    const custId = req.params.id;
    try {
        const [events] = await db.execute(`
            SELECT e.id, e.title, e.game_title, e.event_date 
            FROM event_registrations r
            JOIN events e ON r.event_id = e.id
            WHERE r.customer_id = ?
            ORDER BY e.event_date DESC
            LIMIT 5
        `, [custId]);
        res.json(events);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});
// ==========================================
// PACK STORAGE SYSTEM (With Audit Log)
// ==========================================

// 1. GET: See all stored packs (Current Balances)
app.get('/api/storage', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT p.id, c.id as customer_id, c.name, c.contact_info, p.game_title, p.pack_type, p.quantity, p.last_updated
      FROM customer_packs p
      JOIN customers c ON p.customer_id = c.id
      WHERE p.quantity > 0
      ORDER BY p.last_updated DESC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch storage.' });
  }
});

// 2. GET: See Transaction History (Updated with Event Date)
app.get('/api/storage/history/:customerId', async (req, res) => {
    const custId = req.params.customerId;
    try {
        const [history] = await db.execute(`
            SELECT t.transaction_date, t.game_title, t.pack_type, t.amount, 
                   e.title as event_name, e.event_date 
            FROM pack_transactions t
            LEFT JOIN events e ON t.event_id = e.id
            WHERE t.customer_id = ?
            ORDER BY t.transaction_date DESC
        `, [custId]);
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

// 3. POST: Deposit/Withdraw (Now Logs History!)
app.post('/api/storage/update', async (req, res) => {
  const { customer_id, game_title, pack_type, change_amount, event_id } = req.body;
  
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // A. Security Check (Same as before)
    if (change_amount > 0) {
        if (!event_id) throw new Error("You must select the Event this customer played in.");
        
        const [registration] = await connection.execute(
            `SELECT id FROM event_registrations WHERE customer_id = ? AND event_id = ?`,
            [customer_id, event_id]
        );
        if (registration.length === 0) throw new Error("Security Alert: Customer did NOT join that event.");
    }

    // B. Update Balance (Customer Packs Table)
    const [existing] = await connection.execute(
      `SELECT id, quantity FROM customer_packs 
       WHERE customer_id = ? AND game_title = ? AND pack_type = ?`,
      [customer_id, game_title, pack_type || 'Standard Booster']
    );

    if (existing.length > 0) {
      const newQuantity = existing[0].quantity + parseInt(change_amount);
      if (newQuantity < 0) throw new Error("Not enough packs to withdraw.");
      await connection.execute('UPDATE customer_packs SET quantity = ? WHERE id = ?', [newQuantity, existing[0].id]);
    } else {
      if (change_amount < 0) throw new Error("No packs found to withdraw.");
      await connection.execute(
        `INSERT INTO customer_packs (customer_id, game_title, pack_type, quantity) VALUES (?, ?, ?, ?)`,
        [customer_id, game_title, pack_type || 'Standard Booster', change_amount]
      );
    }

    // C. CREATE AUDIT LOG (New Step!)
    await connection.execute(
        `INSERT INTO pack_transactions (customer_id, game_title, pack_type, amount, event_id) 
         VALUES (?, ?, ?, ?, ?)`,
        [customer_id, game_title, pack_type || 'Standard Booster', change_amount, event_id || null]
    );

    await connection.commit();
    res.json({ message: 'Storage updated & Logged!' });

  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(500).json({ error: error.message || 'Update failed' });
  } finally {
    connection.release();
  }
});

// ==========================================
// KEEP-ALIVE (Prevents Aiven from sleeping)
// ==========================================
setInterval(async () => {
  try {
    await db.execute('SELECT 1');
    // console.log('⏰ Keep-alive ping successful'); 
  } catch (error) {
    console.error('⏰ Keep-alive ping failed:', error.message);
  }
}, 5 * 60 * 1000); 

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
