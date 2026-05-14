import pg from 'pg'
const { Pool } = pg

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
})

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      phone TEXT PRIMARY KEY,
      name TEXT,
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS labels (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      color TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_labels (
      phone TEXT REFERENCES contacts(phone) ON DELETE CASCADE,
      label_id INTEGER REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (phone, label_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  `)

  // Insertar etiquetas por defecto
  const labels = [
    { name: 'Proveedor', color: '#6366f1' },
    { name: 'Socio', color: '#f59e0b' },
    { name: 'Clases', color: '#10b981' },
    { name: 'Torneo', color: '#ef4444' },
    { name: 'Liga', color: '#3b82f6' }
  ]
  for (const l of labels) {
    await pool.query(
      `INSERT INTO labels (name, color) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [l.name, l.color]
    )
  }

  console.log('[DB] Inicializada correctamente')
}

// Contactos
export async function upsertContact(phone, name) {
  await pool.query(`
    INSERT INTO contacts (phone, name) VALUES ($1, $2)
    ON CONFLICT (phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name), updated_at = NOW()
  `, [phone, name])
}

export async function updateContact(phone, { name, notes }) {
  await pool.query(`
    UPDATE contacts SET name = $2, notes = $3, updated_at = NOW() WHERE phone = $1
  `, [phone, name, notes])
}

export async function getContact(phone) {
  const r = await pool.query(`
    SELECT c.*, array_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color)) 
      FILTER (WHERE l.id IS NOT NULL) as labels
    FROM contacts c
    LEFT JOIN contact_labels cl ON cl.phone = c.phone
    LEFT JOIN labels l ON l.id = cl.label_id
    WHERE c.phone = $1
    GROUP BY c.phone
  `, [phone])
  return r.rows[0] || null
}

export async function getAllContacts() {
  const r = await pool.query(`
    SELECT c.*, array_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color))
      FILTER (WHERE l.id IS NOT NULL) as labels
    FROM contacts c
    LEFT JOIN contact_labels cl ON cl.phone = c.phone
    LEFT JOIN labels l ON l.id = cl.label_id
    GROUP BY c.phone
    ORDER BY c.updated_at DESC
  `)
  return r.rows
}

// Etiquetas
export async function getAllLabels() {
  const r = await pool.query(`SELECT * FROM labels ORDER BY name`)
  return r.rows
}

export async function setContactLabels(phone, labelIds) {
  await pool.query(`DELETE FROM contact_labels WHERE phone = $1`, [phone])
  for (const id of labelIds) {
    await pool.query(`INSERT INTO contact_labels (phone, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [phone, id])
  }
}

// Mensajes
export async function saveMessage(phone, role, content, agent = null) {
  await pool.query(
    `INSERT INTO messages (phone, role, content, agent) VALUES ($1, $2, $3, $4)`,
    [phone, role, content, agent]
  )
}

export async function getMessages(phone, limit = 100) {
  const r = await pool.query(
    `SELECT * FROM messages WHERE phone = $1 ORDER BY created_at ASC LIMIT $2`,
    [phone, limit]
  )
  return r.rows
}

export async function getRecentConversations() {
  const r = await pool.query(`
    SELECT DISTINCT ON (m.phone)
      m.phone, m.content as last_message, m.role as last_role, m.created_at,
      c.name as contact_name,
      array_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color))
        FILTER (WHERE l.id IS NOT NULL) as labels
    FROM messages m
    LEFT JOIN contacts c ON c.phone = m.phone
    LEFT JOIN contact_labels cl ON cl.phone = m.phone
    LEFT JOIN labels l ON l.id = cl.label_id
    GROUP BY m.phone, m.content, m.role, m.created_at, c.name
    ORDER BY m.phone, m.created_at DESC
  `)
  return r.rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
}
