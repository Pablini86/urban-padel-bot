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
      status TEXT NOT NULL DEFAULT 'nuevo',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'nuevo';

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

    -- Sistema de campañas (broadcasts) — plantillas aprobadas por Meta, campañas
    -- reutilizables por plantilla, y el progreso de envío por contacto.
    CREATE TABLE IF NOT EXISTS templates (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      language TEXT NOT NULL DEFAULT 'es_MX',
      category TEXT NOT NULL DEFAULT 'UTILITY',
      body_preview TEXT,
      variables TEXT[] NOT NULL DEFAULT '{}',
      buttons TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      template_id INTEGER REFERENCES templates(id),
      audience_label TEXT,
      status TEXT NOT NULL DEFAULT 'borrador',
      -- borrador | enviando | pausada | completada
      daily_cap INTEGER NOT NULL DEFAULT 25,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS campaign_contacts (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      vars JSONB NOT NULL DEFAULT '{}',
      estado TEXT NOT NULL DEFAULT 'pendiente',
      -- pendiente | enviando | enviado | entregado | leido | respondido | fallido | opt_out
      wamid TEXT,
      paso_actual TEXT,
      enviado_at TIMESTAMPTZ,
      ultimo_evento_at TIMESTAMPTZ,
      recordatorios INTEGER NOT NULL DEFAULT 0,
      UNIQUE(campaign_id, phone)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign ON campaign_contacts(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_phone ON campaign_contacts(phone);
    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_wamid ON campaign_contacts(wamid);

    CREATE TABLE IF NOT EXISTS campaign_responses (
      id SERIAL PRIMARY KEY,
      campaign_contact_id INTEGER NOT NULL REFERENCES campaign_contacts(id) ON DELETE CASCADE,
      pregunta TEXT NOT NULL,
      valor TEXT,
      valor_num INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Opt-out global de campañas (no aplica al bot normal de servicio a cliente)
    CREATE TABLE IF NOT EXISTS campaign_optouts (
      phone TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `)

  // Insertar etiquetas por defecto
  const labels = [
    { name: 'Proveedor', color: '#6366f1' },
    { name: 'Socio', color: '#f59e0b' },
    { name: 'Clases', color: '#10b981' },
    { name: 'Torneo', color: '#ef4444' },
    { name: 'Liga', color: '#3b82f6' },
    { name: 'Necesita humano', color: '#dc2626' }
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

// Pasa una conversación de 'nuevo' a 'abierto' la primera vez que el equipo la abre en el panel
export async function markConversationOpened(phone) {
  await pool.query(`UPDATE contacts SET status = 'abierto' WHERE phone = $1 AND status = 'nuevo'`, [phone])
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

export async function createLabel(name, color) {
  const r = await pool.query(
    `INSERT INTO labels (name, color) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [name, color]
  )
  return r.rows[0]
}

// Agrega una etiqueta a un contacto sin tocar las que ya tiene (usado por el bot para auto-etiquetar)
export async function addLabelIfMissing(phone, labelName) {
  const label = await pool.query(`SELECT id FROM labels WHERE name = $1`, [labelName])
  if (!label.rows[0]) return
  await pool.query(
    `INSERT INTO contact_labels (phone, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [phone, label.rows[0].id]
  )
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

// Plantillas de WhatsApp (deben existir ya aprobadas en Meta con este mismo nombre)
export async function createTemplate({ name, language, category, bodyPreview, variables, buttons }) {
  const r = await pool.query(
    `INSERT INTO templates (name, language, category, body_preview, variables, buttons)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE SET language=EXCLUDED.language, category=EXCLUDED.category,
       body_preview=EXCLUDED.body_preview, variables=EXCLUDED.variables, buttons=EXCLUDED.buttons
     RETURNING *`,
    [name, language || 'es_MX', category || 'UTILITY', bodyPreview || null, variables || [], buttons || []]
  )
  return r.rows[0]
}

export async function getTemplates() {
  const r = await pool.query(`SELECT * FROM templates ORDER BY created_at DESC`)
  return r.rows
}

// Campañas
export async function createCampaign({ name, templateId, audienceLabel, dailyCap }) {
  const r = await pool.query(
    `INSERT INTO campaigns (name, template_id, audience_label, daily_cap) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name, templateId, audienceLabel || null, dailyCap || 25]
  )
  return r.rows[0]
}

export async function getCampaigns() {
  const r = await pool.query(`
    SELECT c.*, t.name as template_name,
      COUNT(cc.id) as total_contactos,
      COUNT(cc.id) FILTER (WHERE cc.estado NOT IN ('pendiente','opt_out')) as ya_procesados
    FROM campaigns c
    LEFT JOIN templates t ON t.id = c.template_id
    LEFT JOIN campaign_contacts cc ON cc.campaign_id = c.id
    GROUP BY c.id, t.name
    ORDER BY c.created_at DESC
  `)
  return r.rows
}

export async function getCampaign(id) {
  const r = await pool.query(`
    SELECT c.*, t.name as template_name, t.body_preview, t.variables, t.buttons
    FROM campaigns c LEFT JOIN templates t ON t.id = c.template_id
    WHERE c.id = $1
  `, [id])
  return r.rows[0] || null
}

export async function getCampaignContacts(campaignId) {
  const r = await pool.query(
    `SELECT * FROM campaign_contacts WHERE campaign_id = $1 ORDER BY id`, [campaignId]
  )
  return r.rows
}

export async function getCampaignStats(campaignId) {
  const r = await pool.query(
    `SELECT estado, COUNT(*) as n FROM campaign_contacts WHERE campaign_id = $1 GROUP BY estado`,
    [campaignId]
  )
  return r.rows
}

// Arma la audiencia de una campaña a partir de una etiqueta existente, respetando opt-outs.
// Devuelve cuántos contactos se agregaron.
export async function addAudienceFromLabel(campaignId, labelName) {
  const r = await pool.query(`
    INSERT INTO campaign_contacts (campaign_id, phone, vars)
    SELECT $1, c.phone, jsonb_build_object('nombre_corto', c.name)
    FROM contacts c
    JOIN contact_labels cl ON cl.phone = c.phone
    JOIN labels l ON l.id = cl.label_id AND l.name = $2
    WHERE NOT EXISTS (SELECT 1 FROM campaign_optouts o WHERE o.phone = c.phone)
    ON CONFLICT (campaign_id, phone) DO NOTHING
    RETURNING id
  `, [campaignId, labelName])
  return r.rowCount
}

// Cuenta cuántos contactos tiene una etiqueta, sin agregarlos aún (para la vista previa)
export async function countLabelAudience(labelName) {
  const r = await pool.query(`
    SELECT COUNT(*) as n
    FROM contacts c
    JOIN contact_labels cl ON cl.phone = c.phone
    JOIN labels l ON l.id = cl.label_id AND l.name = $1
    WHERE NOT EXISTS (SELECT 1 FROM campaign_optouts o WHERE o.phone = c.phone)
  `, [labelName])
  return Number(r.rows[0].n)
}

export async function isOptedOut(phone) {
  const r = await pool.query(`SELECT 1 FROM campaign_optouts WHERE phone = $1`, [phone])
  return r.rowCount > 0
}

export async function addOptOut(phone) {
  await pool.query(`INSERT INTO campaign_optouts (phone) VALUES ($1) ON CONFLICT DO NOTHING`, [phone])
}

export async function getRecentConversations() {
  const r = await pool.query(`
    SELECT 
      m.phone,
      m.content as last_message,
      m.role as last_role,
      m.created_at,
      c.name as contact_name,
      COALESCE(c.status, 'nuevo') as status,
      COALESCE(
        json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color))
        FILTER (WHERE l.id IS NOT NULL), '[]'
      ) as labels
    FROM messages m
    INNER JOIN (
      SELECT phone, MAX(created_at) as max_ts
      FROM messages GROUP BY phone
    ) latest ON m.phone = latest.phone AND m.created_at = latest.max_ts
    LEFT JOIN contacts c ON c.phone = m.phone
    LEFT JOIN contact_labels cl ON cl.phone = m.phone
    LEFT JOIN labels l ON l.id = cl.label_id
    GROUP BY m.phone, m.content, m.role, m.created_at, c.name, c.status
    ORDER BY m.created_at DESC
  `)
  return r.rows
}
