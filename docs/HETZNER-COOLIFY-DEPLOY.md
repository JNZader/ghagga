# Guía Paso a Paso: Hetzner + Coolify + GHAGGA

## 🎯 Objetivo

Migrar GHAGGA de Render/Northflank/Neon/Inngest a un stack 100% self-hosted en Hetzner CX21 con Coolify.

**Tiempo estimado**: 2-3 horas  
**Costo final**: ~$7.55/mes (VPS + dominio)

---

## 📋 Pre-requisitos

- [ ] Cuenta en Hetzner (https://hetzner.com)
- [ ] Cuenta en Cloudflare (https://cloudflare.com) con tu dominio configurado
- [ ] Cuenta en GitHub (para el código)
- [ ] Terminal con SSH (Linux/Mac: built-in, Windows: Git Bash o PowerShell)
- [ ] Todos los secretos expuestos ROTADOS (ver `SECRET-ROTATION-GUIDE.md`)

---

## PARTE 1: Crear VPS en Hetzner (15 min)

### Paso 1.1: Registrarse/Login en Hetzner

1. Ir a https://console.hetzner.cloud/
2. Click **"Log in"** (arriba derecha)
3. Si no tenés cuenta: **"Sign up"** → verificar email → agregar tarjeta (€1 que se devuelve)

### Paso 1.2: Crear Proyecto

1. En el dashboard de Hetzner, click **"Add Project"** (botón azul)
2. **Project name**: `ghagga-production`
3. Click **"Create project"**
4. Seleccionar el proyecto recién creado del dropdown

### Paso 1.3: Agregar SSH Key (IMPORTANTE)

1. En el menú lateral izquierdo, click **"Security"**
2. Tab **"SSH Keys"**
3. Click **"Add SSH Key"** (botón azul arriba derecha)
4. **Name**: `mi-laptop`
5. **Public Key**: Pegar tu clave pública

   ```bash
   # En tu terminal local, ejecutar:
   cat ~/.ssh/id_rsa.pub
   
   # Si no existe, generar primero:
   ssh-keygen -t rsa -b 4096 -C "tu-email@ejemplo.com"
   # Presionar Enter 3 veces (valores por defecto)
   ```

6. Click **"Add SSH Key"**

### Paso 1.4: Crear el Servidor (CX21)

1. En el menú lateral, click **"Servers"**
2. Click **"Add Server"** (botón azul grande)
3. Configurar:

   | Campo | Valor |
   |-------|-------|
   | **Location** | `Falkenstein` (Alemania) o `Helsinki` |
   | **Image** | `Ubuntu 22.04` (seleccionar de la lista) |
   | **Type** | `Shared vCPU` → `CX21` (2 vCPU, 4GB RAM, 40GB) |
   | **Networking** | ✅ IPv4 (default), ✅ IPv6 (default) |
   | **SSH Key** | Seleccionar la que creaste (`mi-laptop`) |
   | **Name** | `coolify-server` |

4. Click **"Create & Buy Now"**
5. Esperar 1 minuto a que diga **"Running"**
6. **Anotar la IP pública** (ej: `78.46.123.45`)

### Paso 1.5: Verificar conexión SSH

```bash
# En tu terminal local
ssh root@TU_IP_AQUI

# Ejemplo:
# ssh root@78.46.123.45

# Debería conectar sin pedir password
# Verás: root@coolify-server:~#
```

Si funciona: `exit` para salir

---

## PARTE 2: Configurar DNS en Cloudflare (10 min)

### Paso 2.1: Crear registro A para Coolify

1. Ir a https://dash.cloudflare.com
2. Seleccionar tu dominio (ej: `tudominio.com`)
3. Click **"DNS"** (en el menú lateral izquierdo)
4. Click **"Add record"**
5. Configurar:

   | Campo | Valor |
   |-------|-------|
   | **Type** | `A` |
   | **Name** | `coolify` (esto creará coolify.tudominio.com) |
   | **IPv4 address** | `TU_IP_DE_HETZNER` (ej: 78.46.123.45) |
   | **TTL** | `Auto` |
   | **Proxy status** | 🟡 DNS only (gris, NARANJA APAGADO) |

6. Click **"Save"**

### Paso 2.2: Crear registro A para GHAGGA API

1. Click **"Add record"** otra vez
2. Configurar:

   | Campo | Valor |
   |-------|-------|
   | **Type** | `A` |
   | **Name** | `api` (esto creará api.tudominio.com) |
   | **IPv4 address** | `TU_IP_DE_HETZNER` (misma IP) |
   | **TTL** | `Auto` |
   | **Proxy status** | 🟡 DNS only (gris, NARANJA APAGADO) |

3. Click **"Save"**

### Paso 2.3: Verificar DNS (esperar 1-5 minutos)

```bash
# En tu terminal local
nslookup coolify.tudominio.com
nslookup api.tudominio.com

# Debería responder con tu IP de Hetzner
```

---

## PARTE 3: Instalar Coolify (20 min)

### Paso 3.1: Conectar por SSH y actualizar sistema

```bash
# Conectar al servidor
ssh root@TU_IP

# Actualizar Ubuntu
apt update && apt upgrade -y

# Instalar herramientas útiles
apt install -y curl wget git htop
```

### Paso 3.2: Instalar Coolify

```bash
# Ejecutar el script oficial de instalación
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash

# Esperar 3-5 minutos...
# Verás mensajes de instalación de Docker y Coolify
```

### Paso 3.3: Verificar instalación

```bash
# Verificar que Docker está corriendo
docker ps

# Deberías ver containers de Coolify corriendo
```

### Paso 3.4: Configurar Coolify por primera vez

1. Abrir navegador: `http://TU_IP:8000`
   - Ejemplo: `http://78.46.123.45:8000`

2. **Registration** (primera vez):
   - **Name**: `Admin`
   - **Email**: tu-email@ejemplo.com
   - **Password**: (crear password seguro, guardarlo)
   - Click **"Register"**

3. **Wizard de Setup**:
   - **Instance Domain**: `coolify.tudominio.com`
   - **Default Redirect**: `https://coolify.tudominio.com`
   - **Instance Name**: `GHAGGA Production`
   - Click **"Continue"**

4. **SSH Key**:
   - Coolify mostrará una SSH key pública
   - Copiar todo el texto (empieza con `ssh-rsa` o `ssh-ed25519`)
   - **NO cerrar esta ventana todavía**

5. **Agregar SSH Key a Hetzner** (en otra pestaña):
   - Ir a https://console.hetzner.cloud → Security → SSH Keys
   - Click **"Add SSH Key"**
   - **Name**: `coolify-deploy`
   - **Public Key**: Pegar la key que copiaste de Coolify
   - Click **"Add SSH Key"**

6. Volver a Coolify, click **"Continue"**

7. **Email Settings** (para notificaciones Let's Encrypt):
   - **SMTP Host**: (dejar vacío por ahora, opcional)
   - Click **"Continue"**

8. **Server Setup**:
   - Coolify detectará tu servidor automáticamente
   - Click **"Validate Server"**
   - Esperar verificación
   - Click **"Continue"**

9. **Finish**: Click **"Go to Dashboard"**

### Paso 3.5: Configurar HTTPS (SSL)

1. En Coolify Dashboard → **Settings** (engranaje arriba derecha)
2. Tab **"Instance Settings"**
3. **Instance Domain**: Verificar que dice `coolify.tudominio.com`
4. Scroll abajo a **"SSL/TLS"**
5. **Let's Encrypt Enabled**: ✅ Toggle ON
6. Click **"Save"**

7. Esperar 1-2 minutos
8. Refrescar navegador: `https://coolify.tudominio.com`
9. Debería cargar con HTTPS (🔒 verde)

---

## PARTE 4: Configurar GitHub en Coolify (10 min)

### Paso 4.1: Conectar GitHub

1. En Coolify Dashboard → **Sources** (menú lateral)
2. Click **"GitHub App"**
3. Click **"Create a GitHub App"**
4. Configurar:
   - **Name**: `coolify-ghagga`
   - **Organization**: (tu usuario personal o organización)
5. Click **"Create GitHub App"**
6. Serás redirigido a GitHub → Click **"Install"**
7. Seleccionar: **"Only select repositories"**
8. Buscar y seleccionar: `ghagga` (o tu repo)
9. Click **"Install"**
10. Volver a Coolify → Click **"Reload"**

### Paso 4.2: Verificar conexión

1. En Coolify → **Sources**
2. Debería aparecer tu GitHub App con status ✅ **Connected**

---

## PARTE 5: Deployar GHAGGA en Coolify (30 min)

### Paso 5.1: Crear Nuevo Proyecto

1. Coolify Dashboard → **"New Project"** (botón azul)
2. **Name**: `ghagga`
3. **Description**: `Code review automation`
4. Click **"Create Project"**
5. Click en el proyecto `ghagga` para entrar

### Paso 5.2: Crear PostgreSQL

1. Dentro del proyecto → **"+ New Resource"**
2. Seleccionar **"PostgreSQL"**
3. Configurar:
   - **Name**: `ghagga-db`
   - **Version**: `16`
   - **Username**: `ghagga` (default)
   - **Password**: Click **"Generate"** (copiar y guardar!)
   - **Database**: `ghagga` (default)
4. Click **"Create"**
5. Esperar 1 minuto a que diga **"Running"**
6. Click en el servicio `ghagga-db` para ver detalles
7. **Anotar el DATABASE_URL** que muestra (algo como):
   ```
   postgresql://ghagga:PASSWORD@ghagga-db:5432/ghagga
   ```

### Paso 5.3: Crear Redis

1. Volver al proyecto → **"+ New Resource"**
2. Seleccionar **"Redis"**
3. Configurar:
   - **Name**: `ghagga-redis`
   - **Version**: `7`
4. Click **"Create"**
5. Esperar a que diga **"Running"**
6. **Anotar el REDIS_URL** (debería ser):
   ```
   redis://ghagga-redis:6379
   ```

### Paso 5.4: Crear Aplicación (GHAGGA)

1. Volver al proyecto → **"+ New Resource"**
2. Seleccionar **"Application"**
3. Seleccionar tu repositorio `ghagga` de la lista
4. Configurar:

   | Campo | Valor |
   |-------|-------|
   | **Name** | `ghagga-server` |
   | **Build Pack** | `Docker Compose` |
   | **Base Directory** | `/` (raíz del repo) |
   | **Docker Compose Location** | `docker-compose.yml` |

5. Click **"Continue"**

### Paso 5.5: Configurar Variables de Entorno

**IMPORTANTE**: Usar los NUEVOS secretos rotados, NUNCA los viejos expuestos.

1. En la configuración de la aplicación → tab **"Environment Variables"**
2. Agregar variables una por una:

   **Base de datos:**
   ```
   DATABASE_URL=postgresql://ghagga:PASSWORD@ghagga-db:5432/ghagga
   ```
   (Reemplazar PASSWORD con la que generaste)

   **Redis:**
   ```
   REDIS_URL=redis://ghagga-redis:6379
   REDIS_HOST=ghagga-redis
   REDIS_PORT=6379
   ```

   **GitHub App (NUEVOS valores):**
   ```
   GITHUB_APP_ID=2991025
   GITHUB_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----
   MIIEpAIBAAKCAQEA...
   ...
   -----END RSA PRIVATE KEY-----
   ```
   (Pegar la nueva private key completa, con saltos de línea)

   ```
   GITHUB_WEBHOOK_SECRET=tu_nuevo_webhook_secret
   GITHUB_CLIENT_SECRET=tu_nuevo_client_secret
   ```

   **Secrets (GENERAR NUEVOS):**
   ```bash
   # En tu terminal local, generar:
   openssl rand -hex 32
   # Resultado: 64 caracteres hex
   ```
   ```
   ENCRYPTION_KEY=los_64_caracteres_hex_aqui
   ```

   ```bash
   # Generar otro:
   openssl rand -base64 32
   ```
   ```
   STATE_SECRET=el_resultado_base64_aqui
   ```

   **Configuración:**
   ```
   NODE_ENV=production
   PORT=3000
   ```

3. Click **"Save"** después de cada variable

### Paso 5.6: Configurar Dominio

1. Tab **"General"**
2. Scroll a **"Domains"**
3. Click **"Add Domain"**
4. **Domain**: `api.tudominio.com`
5. **Port**: `3000`
6. Click **"Add"**

### Paso 5.7: Configurar Health Check

1. Seguir en tab **"General"**
2. **Healthcheck Enabled**: ✅ Toggle ON
3. **Healthcheck Path**: `/health`
4. **Healthcheck Port**: `3000`

### Paso 5.8: Deploy!

1. Tab **"Deploy"**
2. Click **"Deploy"** (botón azul grande)
3. Esperar 3-5 minutos (compilación Docker)
4. Ver logs en tiempo real
5. Cuando diga **" deployed successfully"**, verificar:
   - Abrir: `https://api.tudominio.com/health`
   - Debería responder: `{"status":"ok"}` o similar

---

## PARTE 6: Actualizar GitHub App (10 min)

### Paso 6.1: Cambiar Webhook URL

1. Ir a https://github.com/settings/apps/ghagga-review
2. Scroll a **"Webhook URL"**
3. Cambiar a: `https://api.tudominio.com/webhook`
4. **Webhook Secret**: Verificar que sea el nuevo
5. Click **"Save changes"**

### Paso 6.2: Actualizar URLs de la App

1. En la misma página, sección **"Identifying and authorizing users"**
2. **Homepage URL**: `https://api.tudominio.com`
3. **Callback URL**: `https://api.tudominio.com/auth/callback`
4. Click **"Save changes"**

---

## PARTE 7: Testing End-to-End (15 min)

### Paso 7.1: Probar Webhook

1. Ir a cualquier repositorio donde tengas instalada la GHAGGA App
2. Crear un Pull Request de prueba (cualquier cambio)
3. Comentar: `ghagga review`
4. Deberías ver:
   - ✅ Reacción 👀 en el comentario
   - Después de 30-60 segundos: reacción 🚀
   - Después de 1-2 minutos: comentario con la review

### Paso 7.2: Verificar en Coolify

1. Ir a Coolify → Proyecto GHAGGA → Servidor
2. Tab **"Logs"**
3. Deberías ver logs del webhook recibido

### Paso 7.3: Verificar Bull Dashboard (opcional)

Si configuraste el bull-dashboard en docker-compose:

1. En Coolify → **"+ New Resource"** → **"Service"**
2. Buscar `bull-board` o similar
3. O acceder directamente si expusiste el puerto 3001
4. Ver colas de jobs procesándose

---

## PARTE 8: Eliminar Cuentas Viejas (10 min)

**⚠️ SOLO hacer esto después de verificar que todo funciona**

### Paso 8.1: Eliminar Neon

1. https://console.neon.tech
2. Proyecto `neondb` → Settings
3. Scroll abajo → **"Delete project"**
4. Escribir nombre para confirmar
5. Click **"Delete"**
6. (Opcional) Account Settings → **"Delete account"**

### Paso 8.2: Eliminar Inngest

1. https://app.inngest.com
2. Settings → **"Delete account"**
3. Confirmar

### Paso 8.3: Cancelar Render

1. https://dashboard.render.com
2. Servicio `ghagga` → Settings
3. **"Delete service"**
4. Confirmar

### Paso 8.4: Cancelar Northflank

1. https://app.northflank.com
2. Proyecto → Settings
3. **"Delete project"**
4. Confirmar

---

## ✅ CHECKLIST FINAL

### Pre-migración:
- [ ] Secretos rotados (GitHub App)
- [ ] Nuevos secretos generados (ENCRYPTION_KEY, STATE_SECRET)

### Infraestructura:
- [ ] VPS Hetzner CX21 creado
- [ ] DNS configurado en Cloudflare
- [ ] Coolify instalado y accesible en HTTPS
- [ ] GitHub conectado a Coolify

### Deploy:
- [ ] PostgreSQL creado en Coolify
- [ ] Redis creado en Coolify
- [ ] Aplicación GHAGGA deployada
- [ ] Variables de entorno configuradas (NUEVAS)
- [ ] Dominio api.tudominio.com funcionando
- [ ] /health responde OK

### GitHub App:
- [ ] Webhook URL actualizada
- [ ] Webhook Secret nuevo configurado
- [ ] Homepage URL actualizada
- [ ] Callback URL actualizada

### Testing:
- [ ] Comando "ghagga review" funciona
- [ ] Review se genera y se postea
- [ ] No hay errores en logs

### Cleanup:
- [ ] Cuenta Neon eliminada
- [ ] Cuenta Inngest eliminada
- [ ] Servicio Render cancelado
- [ ] Proyecto Northflank eliminado

---

## 🆘 Troubleshooting

### Problema: "Failed to deploy" en Coolify

**Solución**:
1. Verificar logs: Click en el servicio → Tab "Deployment Logs"
2. Error común: Variables de entorno mal configuradas
3. Error común: Dockerfile no encuentra archivo

### Problema: "Connection refused" a PostgreSQL

**Solución**:
1. Verificar que `ghagga-db` está corriendo (status verde)
2. Verificar DATABASE_URL usa `ghagga-db` como hostname (no localhost)
3. Reiniciar servicio: Click en restart

### Problema: Webhook no llega

**Solución**:
1. Verificar DNS apunta a IP correcta: `nslookup api.tudominio.com`
2. Verificar en GitHub App que Webhook URL usa HTTPS
3. Probar manualmente: `curl https://api.tudominio.com/health`

### Problema: GitHub private key formato

**Solución**:
En Coolify, la variable debe ser multilinea:
```
GITHUB_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
...
-----END RSA PRIVATE KEY-----
```
NO usar \n ni formato JSON.

---

## 📊 Costo Final Mensual

| Servicio | Costo |
|----------|-------|
| Hetzner CX21 | $6.55 |
| Dominio .com | ~$1.00 |
| **Total** | **~$7.55/mes** |

**Ahorro**: ~$20-50/mes vs SaaS

---

## 🎉 ¡Listo!

Tu GHAGGA ahora corre 100% self-hosted en tu propio VPS con:
- ✅ PostgreSQL local (0ms latency)
- ✅ BullMQ + Redis (reemplaza Inngest)
- ✅ SSL automático (Let's Encrypt)
- ✅ Backups automáticos
- ✅ Múltiples proyectos en mismo servidor
- ✅ Sin vendor lock-in

**¿Problemas?** Revisar logs en Coolify → Servicio → Logs
