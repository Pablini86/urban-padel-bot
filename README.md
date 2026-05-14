# Urban Padel Bot

 
Bot de WhatsApp con IA para Urban Padel. Responde preguntas del club y consulta disponibilidad en Playtomic en tiempo real.

## Variables de entorno requeridas

Copia `.env.example` a `.env` y llena los valores:

| Variable | Dónde conseguirla |
|---|---|
| `WHATSAPP_TOKEN` | Meta for Developers → System Users → Token |
| `PHONE_NUMBER_ID` | Meta for Developers → WhatsApp → API Setup |
| `WEBHOOK_VERIFY_TOKEN` | Tú lo inventas (ej. `urban_padel_2025`) |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `PLAYTOMIC_TENANT_ID` | URL de tu club en playtomic.io/clubs/**ESTE-ID** |

## Despliegue en Railway

1. Sube este repo a GitHub
2. En Railway: New Project → Deploy from GitHub
3. Agrega las variables de entorno en Settings → Variables
4. Railway genera una URL pública automáticamente

## Endpoint del webhook

Una vez desplegado, tu webhook es:
```
https://TU-APP.railway.app/webhook
```

Úsala en Meta for Developers → WhatsApp → Configuration → Webhook.
