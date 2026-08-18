# Spec — Encuesta de satisfacción Curso de Verano (motor propio, sin ManyChat)

Para implementar dentro de `urban-padel-bot`. Reutiliza `whatsapp.js`, `db.js` e `index.js` existentes.

---

## 1. Base de contactos

Archivo: `base_papas_encuesta.csv` — **40 papás únicos**, 60 niños.

Columnas: `telefono` (E.164), `nombre_papa`, `nombre_corto`, `num_hijos`, `hijos`, `hijo_principal`, `hijo_nombre_corto`, `edades`.

### Limpieza ya aplicada
- Teléfonos normalizados a `+52XXXXXXXXXX` (10 dígitos, sin el `1` de móvil — Meta lo acepta así para MX).
- Deduplicado por teléfono: papás con varios hijos quedan en un solo registro.
- `Gabriela Arambula` traía lada `34` (typo de `33`) → corregido y fusionado.
- `SR Guzman` / `Victor Guzman` mismo teléfono y mismo niño duplicado → fusionado.
- `Yuri Gutierrez` / `Dora Yuridia Gutierrez` mismo teléfono → fusionado.

### Revisar a mano antes de enviar
- `+529842028802` (Martha Amalia Avalos) — lada 984, Playa del Carmen. Verificar.
- `Dolores Santiago` (+523326503290) tiene 6 niños: Mia, Ines, Sofia, Cristen, Blessie, Ambar. Con esa cantidad, personalizar con nombre de un solo hijo suena raro → usar fallback "tus hijos".

**Regla de personalización:** si `num_hijos == 1` usa `hijo_nombre_corto`; si es mayor, usa `"tus hijos"`.

---

## 2. Esquema de base de datos (Postgres)

```sql
CREATE TABLE encuesta_contactos (
  id            SERIAL PRIMARY KEY,
  telefono      TEXT UNIQUE NOT NULL,
  nombre_papa   TEXT,
  nombre_corto  TEXT,
  hijos         TEXT,
  hijo_corto    TEXT,
  num_hijos     INT,
  estado        TEXT DEFAULT 'pendiente',
  -- pendiente | enviado | en_curso | completado | opt_out | fallido
  paso_actual   TEXT,
  enviado_at    TIMESTAMPTZ,
  ultimo_msg_at TIMESTAMPTZ,
  recordatorios INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE encuesta_respuestas (
  id           SERIAL PRIMARY KEY,
  telefono     TEXT REFERENCES encuesta_contactos(telefono),
  pregunta     TEXT NOT NULL,   -- nps | reinscribe | mejora | clinica
  valor        TEXT,            -- respuesta cruda
  valor_num    INT,             -- normalizado cuando aplica
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_resp_tel ON encuesta_respuestas(telefono);
```

> Importante: `encuesta_contactos.estado` es el candado de idempotencia. Nunca mandes a un contacto que ya esté en `enviado` o más adelante.

---

## 3. Máquina de estados del flujo

```json
{
  "campana": "encuesta_verano_2026",
  "pasos": {
    "inicio": {
      "tipo": "template",
      "template": "encuesta_verano_2026",
      "siguiente": "p1_nps"
    },
    "p1_nps": {
      "pregunta": "nps",
      "tipo": "botones",
      "texto": "Del 0 al 10, ¿qué tan probable es que nos recomiendes con otras familias?",
      "opciones": ["0-6", "7-8", "9-10"],
      "validacion": "numero_0_10_o_boton",
      "siguiente": "p2_reinscribe"
    },
    "p2_reinscribe": {
      "pregunta": "reinscribe",
      "tipo": "botones",
      "texto_previo_promotor": "¡Nos alegra muchísimo! 🎾",
      "texto_previo_detractor": "Gracias por la honestidad, nos sirve mucho.",
      "texto": "¿Inscribirías a {hijo} el próximo verano?",
      "opciones": ["Sí", "Aún no sé", "No"],
      "siguiente": "p3_mejora"
    },
    "p3_mejora": {
      "pregunta": "mejora",
      "tipo": "abierta",
      "texto": "Última: ¿algo que podamos mejorar para la próxima edición?",
      "siguiente": "p4_clinica"
    },
    "p4_clinica": {
      "pregunta": "clinica",
      "tipo": "botones",
      "texto": "¡Gracias {nombre} 🙏 Una cosa más: tenemos clínica infantil de pádel todo el año, grupos por edad y con los mismos profes del curso. ¿Te paso info y horarios?",
      "opciones": ["Sí, mándame info", "Ahorita no"],
      "siguiente": "cierre"
    },
    "cierre": {
      "tipo": "final",
      "texto_si_clinica": "¡Perfecto! Te contacta {profe} para acomodar a {hijo} en el grupo de su edad. Cualquier duda, aquí estamos. 🎾",
      "texto_no_clinica": "¡Gracias por tu tiempo {nombre}! Si algún día quieres info de la clínica, escríbenos por aquí. 🎾"
    }
  }
}
```

### Reglas de manejo
- **Timeout de la ventana de 24h:** si `ultimo_msg_at` > 24h y no completó, no puedes seguir con texto libre. Marcar `estado = 'en_curso'` y reactivar con plantilla de recordatorio.
- **Respuesta no reconocida:** repite la pregunta una vez con las opciones. A la segunda, avanza al siguiente paso guardando `valor = 'sin_respuesta'`.
- **Opt-out:** si el mensaje contiene `baja`, `stop`, `no me escriban`, `dar de baja` → `estado = 'opt_out'`, responder confirmación y no volver a contactar nunca.
- **NPS:** aceptar tanto el botón como que escriban un número suelto 0-10. Guardar en `valor_num`.

---

## 4. Plantilla para aprobación de Meta

Categoría: **Utility** (es seguimiento post-servicio, no promoción — sube probabilidad de aprobación y baja el costo).
Nombre: `encuesta_verano_2026`
Idioma: `es_MX`

**Body:**
```
Hola {{1}} 👋 Gracias por confiarnos el verano de {{2}} en Urban Pádel Life.
Queremos mejorar para la próxima edición y tu opinión pesa mucho. Son 3 preguntas rápidas, menos de 1 minuto.

Del 0 al 10, ¿qué tan probable es que nos recomiendes con otras familias?
```

**Botones (Quick reply):** `0-6` · `7-8` · `9-10`

Variables: `{{1}}` = `nombre_corto`, `{{2}}` = `hijo_corto` o `"tus hijos"`.

**Ejemplo para el campo de muestra de Meta:** `{{1}}` = Dafne, `{{2}}` = tus hijos.

### Plantilla de recordatorio (aparte)
Nombre: `encuesta_verano_2026_recordatorio`, misma categoría.
```
Hola {{1}}, te escribimos hace unos días sobre el curso de verano de {{2}}. ¿Nos regalas 1 minuto para 3 preguntas? Nos ayuda mucho a mejorar. 🎾
```
Botón: `Va, empezamos` · `Ahorita no`

---

## 5. Envío — cuidados operativos

- **Lotes de 20-25 por día** los primeros 2 días. Con 40 contactos, mandar todo en 2 días. Número nuevo o con poco historial saliente quema calidad rápido si mandas 40 de golpe.
- **Horario:** martes a jueves, 7:00-9:00 pm hora Guadalajara.
- **Rate limit:** 1 mensaje cada 2-3 segundos, no en paralelo.
- **Recordatorio:** a los 3 días, solo a quien esté en `enviado` sin ninguna respuesta. Máximo 1 recordatorio (`recordatorios <= 1`).
- **Manejo de errores:** si la API regresa error `131026` (número no en WhatsApp) o `470` → marcar `fallido`, no reintentar.
- **Vigila la calidad del número** en WhatsApp Manager. Si baja a amarillo, pausa el envío.

---

## 6. Métricas a calcular

```sql
-- NPS
WITH n AS (
  SELECT valor_num FROM encuesta_respuestas WHERE pregunta='nps' AND valor_num IS NOT NULL
)
SELECT
  count(*) AS respuestas,
  round(100.0*count(*) FILTER (WHERE valor_num>=9)/count(*),1) AS pct_promotores,
  round(100.0*count(*) FILTER (WHERE valor_num<=6)/count(*),1) AS pct_detractores,
  round(100.0*count(*) FILTER (WHERE valor_num>=9)/count(*)
      - 100.0*count(*) FILTER (WHERE valor_num<=6)/count(*),1) AS nps
FROM n;

-- Embudo
SELECT estado, count(*) FROM encuesta_contactos GROUP BY estado ORDER BY 2 DESC;

-- Intención de reinscripción
SELECT valor, count(*) FROM encuesta_respuestas WHERE pregunta='reinscribe' GROUP BY 1;

-- Leads calientes de clínica (esta es la lista que le pasas a los profes)
SELECT c.nombre_papa, c.telefono, c.hijos
FROM encuesta_respuestas r
JOIN encuesta_contactos c ON c.telefono = r.telefono
WHERE r.pregunta='clinica' AND r.valor ILIKE 'Sí%';

-- Respuestas abiertas para leer
SELECT c.nombre_papa, r.valor
FROM encuesta_respuestas r JOIN encuesta_contactos c ON c.telefono=r.telefono
WHERE r.pregunta='mejora' AND length(r.valor) > 3;
```

Benchmark esperado con este flujo: **40-55% de respuesta al NPS**, ~30-40% completan las 3 preguntas. Con 40 contactos son ~18-22 respuestas — muestra chica, así que las abiertas van a valer más que los porcentajes.

---

## 7. Nota sobre el bot existente

El webhook de `index.js` ya rutea mensajes entrantes a `bot.js` (Claude). Necesitas un **interceptor antes** de esa llamada:

```
webhook → ¿el telefono está en encuesta_contactos con estado 'enviado' o 'en_curso'?
   sí → manejar con el motor de encuesta (no llamar a Claude)
   no → flujo normal del bot
```

Al terminar la encuesta (`completado`), el contacto vuelve al flujo normal automáticamente.
