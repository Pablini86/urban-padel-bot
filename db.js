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
    -- vars: columnas extra de un CSV importado (ej. hijo_nombre_corto, num_hijos),
    -- disponibles para personalizar plantillas al mandar una campaña.
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS vars JSONB NOT NULL DEFAULT '{}';
    -- opted_in_at: candado para poder incluir a alguien en la audiencia de una
    -- campaña masiva. Se marca solo (NOW()) cuando el contacto escribe primero al
    -- bot, o a mano al importar un CSV si se confirma que esa lista dio consentimiento.
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opted_in_at TIMESTAMPTZ;

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
      meta_template_id TEXT,
      approval_status TEXT NOT NULL DEFAULT 'no_enviada',
      -- no_enviada | pendiente | approved | rejected | error
      approval_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS meta_template_id TEXT;
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'no_enviada';
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS approval_error TEXT;
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS header_image_url TEXT;

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

    -- Respuestas automáticas por palabra clave, corren antes que Claude
    CREATE TABLE IF NOT EXISTS automations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      keywords TEXT[] NOT NULL DEFAULT '{}',
      reply_text TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      times_triggered INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Textos y botones editables de las preguntas de encuesta.js (todo lo que
    -- NO es el primer mensaje — ese vive horneado en la plantilla aprobada de
    -- Meta y solo se cambia mandando una plantilla nueva a revisión).
    -- options: [{value,label}] — value es la clave interna que usa la lógica
    -- de ramas (ej. p4_closing_si/no) y nunca se edita desde el dashboard, solo
    -- label (el texto que ve el cliente en el botón).
    CREATE TABLE IF NOT EXISTS survey_steps (
      step TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      text TEXT NOT NULL,
      options JSONB NOT NULL DEFAULT '[]',
      options_locked BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- image_url: foto opcional del paso, guardada como data URI ya recortada al
    -- formato horizontal de WhatsApp (ver resolveHeaderImage en dashboard/server.js,
    -- reusado para plantillas y para estos pasos). encuesta.js la sube a Meta con
    -- uploadWhatsAppMedia justo antes de mandar el mensaje.
    ALTER TABLE survey_steps ADD COLUMN IF NOT EXISTS image_url TEXT;
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

  // Textos por default de la encuesta (ver spec_encuesta_curso_verano.md) — ON
  // CONFLICT DO NOTHING para que un redeploy nunca pise lo que Pablo ya editó
  // desde el dashboard.
  const surveySteps = [
    { step: 'p1_nps_retry', label: 'NPS — si no entendimos la respuesta', locked: true,
      text: 'No agarré tu respuesta — del 0 al 10, ¿qué tan probable es que nos recomiendes con otras familias?',
      options: [{ value: '0-6', label: '0-6' }, { value: '7-8', label: '7-8' }, { value: '9-10', label: '9-10' }] },
    { step: 'p2_question', label: 'Pregunta 2 — ¿Se reinscribiría?', locked: false,
      text: '¿Inscribirías a {{hijo}} el próximo verano?',
      options: [{ value: 'si', label: 'Sí' }, { value: 'aun_no_se', label: 'Aún no sé' }, { value: 'no', label: 'No' }] },
    { step: 'p2_retry', label: 'Pregunta 2 — si no entendimos la respuesta', locked: false,
      text: 'No te entendí — ¿inscribirías a {{hijo}} el próximo verano?', options: [] },
    { step: 'p3_question', label: 'Pregunta 3 — qué mejorar (abierta)', locked: false,
      text: 'Última: ¿algo que podamos mejorar para la próxima edición?', options: [] },
    { step: 'p4_question', label: 'Pregunta 4 — ¿le interesa la clínica infantil?', locked: false,
      text: 'Gracias. Una cosa más: tenemos clínica infantil de pádel todo el año, grupos por edad y con los mismos profes del curso. ¿Te paso info y horarios?',
      options: [{ value: 'si', label: 'Sí, mándame info' }, { value: 'no', label: 'Ahorita no' }] },
    { step: 'p4_retry', label: 'Pregunta 4 — si no entendimos la respuesta', locked: false,
      text: 'No te entendí — ¿te paso info y horarios de la clínica infantil?', options: [] },
    { step: 'p4_closing_si', label: 'Cierre — si quiere info de la clínica', locked: false,
      text: 'Perfecto, en breve un profe te contacta para acomodarlo en el grupo de su edad. Cualquier duda, aquí estamos.', options: [] },
    { step: 'p4_closing_no', label: 'Cierre — si no le interesa por ahora', locked: false,
      text: 'Gracias por tu tiempo. Si algún día quieres info de la clínica, escríbenos por aquí.', options: [] },
    { step: 'optout_bye', label: 'Respuesta cuando alguien se da de baja', locked: false,
      text: 'Listo, no te vamos a volver a escribir para campañas. Si necesitas algo del club, aquí seguimos.', options: [] }
  ]
  for (const s of surveySteps) {
    await pool.query(
      `INSERT INTO survey_steps (step, label, text, options, options_locked) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (step) DO NOTHING`,
      [s.step, s.label, s.text, JSON.stringify(s.options), s.locked]
    )
  }

  console.log('[DB] Inicializada correctamente')
}

// Encuesta — textos y botones editables (ver comentario de la tabla arriba)
export async function getSurveySteps() {
  const r = await pool.query(`SELECT * FROM survey_steps ORDER BY step`)
  return r.rows
}

export async function getSurveyStepsMap() {
  const rows = await getSurveySteps()
  return Object.fromEntries(rows.map(r => [r.step, r]))
}

export async function updateSurveyStep(step, { text, options, imageUrl }) {
  const existing = await pool.query(`SELECT options_locked, options FROM survey_steps WHERE step = $1`, [step])
  if (!existing.rows[0]) return null
  // Los `value` internos de las opciones nunca se editan desde el dashboard —
  // solo su `label` visible — porque de eso depende a qué rama sigue el flujo
  // (ej. p4_closing_si/no). Si el paso está bloqueado (NPS) o mandan un número
  // distinto de opciones, se ignora lo que venga y se conserva lo que ya había.
  let nextOptions = existing.rows[0].options
  if (!existing.rows[0].options_locked && Array.isArray(options) && options.length === existing.rows[0].options.length) {
    nextOptions = existing.rows[0].options.map((o, i) => ({ value: o.value, label: String(options[i]?.label || o.label).trim().slice(0, 20) }))
  }
  const r = await pool.query(`
    UPDATE survey_steps SET text = $2, options = $3, image_url = $4, updated_at = NOW() WHERE step = $1
    RETURNING *
  `, [step, text, JSON.stringify(nextOptions), imageUrl || null])
  return r.rows[0]
}

// Contactos
export async function upsertContact(phone, name) {
  // opted_in_at solo se pone en el INSERT (contacto nuevo) — que alguien escriba
  // primero al bot ya cuenta como consentimiento para poder contactarlo después.
  // Si el contacto ya existía, ON CONFLICT no lo toca (nunca se le quita ni se
  // le vuelve a poner encima).
  await pool.query(`
    INSERT INTO contacts (phone, name, opted_in_at) VALUES ($1, $2, NOW())
    ON CONFLICT (phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name), updated_at = NOW()
  `, [phone, name])
}

// Importa contactos en lote (ej. desde un CSV), les asigna una etiqueta para poder
// segmentarlos después al armar una campaña, y opcionalmente los marca como opt-in
// (si no se confirma, quedan guardados pero addAudienceFromLabel los excluye).
// `rows` es [{ phone, name, vars }], donde vars son las columnas extra del CSV
// (ej. hijo_nombre_corto, num_hijos) para usarlas al personalizar plantillas.
export async function importContacts(rows, { labelName, labelColor, markOptedIn }) {
  const label = await createLabel(labelName, labelColor || '#5C6670')
  let imported = 0
  for (const row of rows) {
    if (!row.phone) continue
    await pool.query(`
      INSERT INTO contacts (phone, name, vars, opted_in_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (phone) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, contacts.name),
        vars = contacts.vars || EXCLUDED.vars,
        opted_in_at = COALESCE(contacts.opted_in_at, EXCLUDED.opted_in_at),
        updated_at = NOW()
    `, [row.phone, row.name || row.phone, JSON.stringify(row.vars || {}), markOptedIn ? new Date() : null])
    await pool.query(
      `INSERT INTO contact_labels (phone, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [row.phone, label.id]
    )
    imported++
  }
  return { imported, label }
}

export async function updateContact(phone, { name, notes }) {
  await pool.query(`
    UPDATE contacts SET name = $2, notes = $3, updated_at = NOW() WHERE phone = $1
  `, [phone, name, notes])
}

// Alta manual de un contacto de prueba desde el dashboard (a diferencia de
// upsertContact, el opt-in aquí es explícito porque nadie escribió primero).
export async function createContact({ phone, name, optIn, labelIds }) {
  const r = await pool.query(`
    INSERT INTO contacts (phone, name, opted_in_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (phone) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, contacts.name),
      opted_in_at = COALESCE(contacts.opted_in_at, EXCLUDED.opted_in_at),
      updated_at = NOW()
    RETURNING *
  `, [phone, name || null, optIn ? new Date() : null])
  if (labelIds?.length) await setContactLabels(phone, labelIds)
  return r.rows[0]
}

export async function setContactOptIn(phone, optIn) {
  await pool.query(`
    UPDATE contacts SET opted_in_at = $2, updated_at = NOW() WHERE phone = $1
  `, [phone, optIn ? new Date() : null])
}

// No hay FK de campaign_contacts/messages hacia contacts a propósito: borrar
// un contacto del roster no debe borrar el historial de campañas ni de chat.
export async function deleteContact(phone) {
  await pool.query(`DELETE FROM contacts WHERE phone = $1`, [phone])
}

// A qué campañas pertenece un contacto y en qué paso va cada una, para mostrarlo
// en su ficha (ej. confirmar que un contacto de prueba sí quedó en la campaña chica).
export async function getContactCampaigns(phone) {
  const r = await pool.query(`
    SELECT cp.id as campaign_id, cp.name as campaign_name, cc.estado, cc.enviado_at
    FROM campaign_contacts cc
    JOIN campaigns cp ON cp.id = cc.campaign_id
    WHERE cc.phone = $1
    ORDER BY cc.id DESC
  `, [phone])
  return r.rows
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
export async function createTemplate({ name, language, category, bodyPreview, variables, buttons, headerImageUrl }) {
  const r = await pool.query(
    `INSERT INTO templates (name, language, category, body_preview, variables, buttons, header_image_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (name) DO UPDATE SET language=EXCLUDED.language, category=EXCLUDED.category,
       body_preview=EXCLUDED.body_preview, variables=EXCLUDED.variables, buttons=EXCLUDED.buttons,
       header_image_url=EXCLUDED.header_image_url
     RETURNING *`,
    [name, language || 'es_MX', category || 'UTILITY', bodyPreview || null, variables || [], buttons || [], headerImageUrl || null]
  )
  return r.rows[0]
}

export async function getTemplates() {
  const r = await pool.query(`SELECT * FROM templates ORDER BY created_at DESC`)
  return r.rows
}

export async function getTemplate(id) {
  const r = await pool.query(`SELECT * FROM templates WHERE id = $1`, [id])
  return r.rows[0] || null
}

export async function setTemplateSubmitted(id, { metaTemplateId, status, category }) {
  await pool.query(
    `UPDATE templates SET meta_template_id = $2, approval_status = $3, approval_error = NULL,
       category = COALESCE($4, category) WHERE id = $1`,
    [id, metaTemplateId, status, category || null]
  )
}

// Edita el contenido de una plantilla YA aprobada (mismo meta_template_id, mismo
// nombre) en vez de crear una nueva — Meta la vuelve a mandar a revisión pero la
// versión aprobada anterior se sigue usando para enviar mientras tanto. Guarda el
// texto editado localmente aunque la llamada a Meta falle, para no perder lo que
// se escribió en el formulario.
export async function updateTemplateContent(id, { bodyPreview, variables, buttons, headerImageUrl }) {
  await pool.query(
    `UPDATE templates SET body_preview = $2, variables = $3, buttons = $4, header_image_url = $5 WHERE id = $1`,
    [id, bodyPreview, variables || [], buttons || [], headerImageUrl || null]
  )
}

// Falla si ya tiene una campaña creada (la FK a campaigns lo impediría de todos
// modos, pero así el dashboard muestra un mensaje legible en vez de un 500).
export async function deleteTemplate(id) {
  const inUse = await pool.query(`SELECT id FROM campaigns WHERE template_id = $1 LIMIT 1`, [id])
  if (inUse.rows.length) throw new Error('No se puede borrar: ya tiene una campaña creada con esta plantilla')
  await pool.query(`DELETE FROM templates WHERE id = $1`, [id])
}

export async function setTemplateError(id, errorMessage) {
  await pool.query(
    `UPDATE templates SET approval_status = 'error', approval_error = $2 WHERE id = $1`,
    [id, errorMessage]
  )
}

export async function setTemplateStatus(id, { status, rejectedReason }) {
  await pool.query(
    `UPDATE templates SET approval_status = $2, approval_error = $3 WHERE id = $1`,
    [id, status, rejectedReason || null]
  )
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
    SELECT c.*, t.name as template_name, t.language as template_language,
      t.approval_status as template_approval_status, t.body_preview, t.variables,
      t.buttons, t.header_image_url
    FROM campaigns c LEFT JOIN templates t ON t.id = c.template_id
    WHERE c.id = $1
  `, [id])
  return r.rows[0] || null
}

// Reclama hasta `limit` contactos "pendiente" de un jalón, marcándolos "enviando"
// en la misma sentencia — así un doble clic en "Enviar lote" no manda el mismo
// contacto dos veces (FOR UPDATE SKIP LOCKED evita que dos llamadas simultáneas
// agarren la misma fila).
export async function claimPendingCampaignContacts(campaignId, limit) {
  const r = await pool.query(`
    UPDATE campaign_contacts SET estado = 'enviando'
    WHERE id IN (
      SELECT id FROM campaign_contacts
      WHERE campaign_id = $1 AND estado = 'pendiente'
      ORDER BY id LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `, [campaignId, limit])
  return r.rows
}

export async function markContactSent(id, wamid) {
  await pool.query(
    `UPDATE campaign_contacts SET estado = 'enviado', paso_actual = 'p1_nps', wamid = $2, enviado_at = NOW(), ultimo_evento_at = NOW() WHERE id = $1`,
    [id, wamid]
  )
}

export async function markContactFailed(id) {
  await pool.query(
    `UPDATE campaign_contacts SET estado = 'fallido', ultimo_evento_at = NOW() WHERE id = $1`,
    [id]
  )
}

export async function advanceCampaignContact(id, { pasoActual, estado } = {}) {
  await pool.query(
    `UPDATE campaign_contacts SET
       paso_actual = COALESCE($2, paso_actual),
       estado = COALESCE($3, estado),
       ultimo_evento_at = NOW()
     WHERE id = $1`,
    [id, pasoActual || null, estado || null]
  )
}

// El contacto "activo" de una encuesta para un teléfono que escribe — 'enviado'
// (se le mandó la plantilla, todavía sin contestar) o 'en_curso' (ya contestó al
// menos una pregunta). Cualquier otro estado (completado, opt_out, fallido,
// pendiente) significa que ese teléfono no está a media encuesta ahora mismo.
export async function getActiveSurveyContact(phone) {
  const r = await pool.query(
    `SELECT * FROM campaign_contacts WHERE phone = $1 AND estado IN ('enviado', 'en_curso') ORDER BY enviado_at DESC LIMIT 1`,
    [phone]
  )
  return r.rows[0] || null
}

export async function saveCampaignResponse({ campaignContactId, pregunta, valor, valorNum }) {
  await pool.query(
    `INSERT INTO campaign_responses (campaign_contact_id, pregunta, valor, valor_num) VALUES ($1, $2, $3, $4)`,
    [campaignContactId, pregunta, valor ?? null, valorNum ?? null]
  )
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
// Solo entran contactos con opted_in_at (ver upsertContact/importContacts) — es
// el candado que evita mandar campañas a alguien que nunca dio consentimiento.
// vars mezcla nombre_corto (del campo name) con las vars extra del contacto
// (ej. hijo_nombre_corto, num_hijos) para poder personalizar la plantilla.
export async function addAudienceFromLabel(campaignId, labelName) {
  const r = await pool.query(`
    INSERT INTO campaign_contacts (campaign_id, phone, vars)
    SELECT $1, c.phone, jsonb_build_object('nombre_corto', c.name) || COALESCE(c.vars, '{}'::jsonb)
    FROM contacts c
    JOIN contact_labels cl ON cl.phone = c.phone
    JOIN labels l ON l.id = cl.label_id AND l.name = $2
    WHERE c.opted_in_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM campaign_optouts o WHERE o.phone = c.phone)
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
    WHERE c.opted_in_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM campaign_optouts o WHERE o.phone = c.phone)
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

// Automatizaciones (respuestas automáticas por palabra clave, corren antes que Claude)
export async function getAutomations() {
  const r = await pool.query(`SELECT * FROM automations ORDER BY created_at DESC`)
  return r.rows
}

export async function getActiveAutomations() {
  const r = await pool.query(`SELECT * FROM automations WHERE active = true ORDER BY created_at ASC`)
  return r.rows
}

export async function createAutomation({ name, keywords, replyText }) {
  const r = await pool.query(
    `INSERT INTO automations (name, keywords, reply_text) VALUES ($1, $2, $3) RETURNING *`,
    [name, keywords || [], replyText]
  )
  return r.rows[0]
}

export async function updateAutomation(id, { name, keywords, replyText }) {
  const r = await pool.query(
    `UPDATE automations SET name = $2, keywords = $3, reply_text = $4 WHERE id = $1 RETURNING *`,
    [id, name, keywords || [], replyText]
  )
  return r.rows[0] || null
}

export async function setAutomationActive(id, active) {
  const r = await pool.query(
    `UPDATE automations SET active = $2 WHERE id = $1 RETURNING *`,
    [id, active]
  )
  return r.rows[0] || null
}

export async function deleteAutomation(id) {
  await pool.query(`DELETE FROM automations WHERE id = $1`, [id])
}

export async function incrementAutomationTrigger(id) {
  await pool.query(`UPDATE automations SET times_triggered = times_triggered + 1 WHERE id = $1`, [id])
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
